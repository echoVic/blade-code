# Durable Goal Finalization Handoff Release Evidence

- Date: 2026-08-14
- Version: `blade-code@0.10.30`
- Qualified commit: `da431f23b50baf82bd0f439c78804c1086d3e107`
- Command: `bun run qualify:production`

## Result

Production qualification passed all 16 checks.

- Unit: 2,852 passed, 1 skipped
- Integration: 160 passed
- Web: 405 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 51 passed across 13 files

The built CLI and `packages/cli/package.json` both reported `0.10.30`.

## Goal Handoff Matrix

Every cell started from the same cross-store crash fixture:

1. the original durable input and active turn existed;
2. the Goal sidecar contained an independent `verifying/pass` verdict;
3. the final assistant message contained a host-owned turn and Goal finalization
   receipt;
4. the Goal sidecar had not yet changed to `complete`;
5. the turn terminal and durable inbox acknowledgement had not been committed.

| Model | Surface | Duration | Result |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless bare resume | 1.688s | passed |
| DeepSeek V4 Flash | ACP `session/load` | 2.095s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 11.871s | passed |
| DeepSeek V4 Flash | production Chromium Web GUI + reload | 11.070s | passed |
| DeepSeek V4 Pro | Headless bare resume | 2.104s | passed |
| DeepSeek V4 Pro | ACP `session/load` | 1.636s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 11.499s | passed |
| DeepSeek V4 Pro | production Chromium Web GUI + reload | 11.310s | passed |

All eight cells passed without a test retry and proved:

- startup made zero Provider requests for the already completed Goal;
- Goal ID, verification attempt, verifier Session, evidence digest, and Goal
  revision matched before the sidecar changed to `complete`;
- the original final assistant and Goal receipt remained unique;
- the original input received one inbox acknowledgement and one completed turn,
  with no aborted terminal;
- the verified artifact bytes remained unchanged;
- Headless replayed the recovered final response without constructing a new turn;
- TUI and Web did not start a stale pre-reconciliation Goal continuation;
- ACP replayed the final assistant and projected `blade/goal.status=complete`;
- each surface then submitted a new prompt through the transparent proxy and
  received a real Provider response;
- Web retained the final response, follow-up, and complete Goal after reload;
- Provider credentials were absent from JSONL output, ACP updates, PTY evidence,
  browser DOM, and captured diagnostics;
- owned PTY, browser, server, port, proxy, and process resources were reclaimed.

## Deterministic Coverage

Focused deterministic coverage passed 184 runtime/CLI tests and 222
CLI/TUI/Web/ACP projection tests before the full gate. It covers:

- strict nested receipt parsing and malformed receipt rejection;
- exact-match and idempotent GoalStore reconciliation;
- stale Goal ID, revision, verifier identity, attempt, and digest rejection;
- recovery while the turn is active and after the turn terminal already exists;
- startup result replay limited to the current Runtime initialization;
- ordinary inputless resume with no work still failing closed;
- Web and TUI post-initialization rechecks;
- ACP structured Goal replay metadata;
- Runtime `goal.updated` publication and stable Web Goal status selectors.

## Release Boundary

The release tag may include an evidence-only commit after the qualified commit.
No runtime, test, package, lockfile, documentation other than this evidence file,
or build input may differ from
`da431f23b50baf82bd0f439c78804c1086d3e107`.
