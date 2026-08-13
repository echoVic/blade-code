# Durable Root-Turn Auto-Resume Release Evidence

- Date: 2026-08-14
- Version: `blade-code@0.10.29`
- Qualified commit: `b7b4279107f7e05a700c936493287a7fc391324e`
- Command: `bun run qualify:production`

## Result

Production qualification passed all 16 checks.

- Unit: 2,842 passed, 1 skipped
- Integration: 160 passed
- Headless core: 270 passed
- E2E: 14 passed
- Snapshot: 9 passed
- Security: 38 passed
- Web: 405 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 43 passed across 12 files

The built CLI and `packages/cli/package.json` both reported `0.10.29`.

## Root-Turn Matrix

Every cell used the same orphan `Write` crash fixture. The original marker was
already present, the prior tool call had no result, and one durable inbox item
remained pending.

| Model | Surface | Duration | Result |
| --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless bare resume | 3.066s | passed |
| DeepSeek V4 Flash | ACP `session/load` | 3.345s | passed |
| DeepSeek V4 Flash | raw PTY TUI | 12.197s | passed |
| DeepSeek V4 Flash | production Chromium Web GUI + reload | 11.175s | passed |
| DeepSeek V4 Pro | Headless bare resume | 4.474s | passed |
| DeepSeek V4 Pro | ACP `session/load` | 2.616s | passed |
| DeepSeek V4 Pro | raw PTY TUI | 15.284s | passed |
| DeepSeek V4 Pro | production Chromium Web GUI + reload | 11.633s | passed |

All eight cells passed without a test retry and proved:

- the original `Write` tool call occurred exactly once;
- process-restart reconciliation committed exactly one uncertain-side-effect receipt;
- the resumed model called `Read` exactly once;
- no resumed `Write`, `Edit`, `ApplyPatch`, or `Bash` mutation occurred;
- the original durable input was model-visible once and no wake-up prompt was added;
- the inbox was acknowledged and removed only after durable completion;
- the marker bytes remained unchanged;
- Provider credentials were absent from transcript, ACP updates, PTY evidence, and DOM;
- owned PTY, browser, server, port, and process resources were reclaimed.

## Additional Recovery Evidence

The strengthened GPT durable-interaction trajectories passed on both Web and
ACP in the final production run:

- Web recovered answer -> real `Write` -> durable completion: 9.203s
- ACP `session/load` -> real `Write` -> durable inbox acknowledgement: 9.245s

The ACP assertion waits for the target content, final assistant marker, and
durable inbox acknowledgement before cleanup. A final-message persistence
failure therefore cannot pass because an earlier tool side effect exists.

## Retry Disclosure

One pre-existing leaderless foreground process trajectory passed after one
Vitest retry. The root-turn eight-cell matrix and both durable-interaction
trajectories passed without retries. The complete production command exited
successfully with `16/16` checks.

## Release Boundary

The release tag may include an evidence-only commit after the qualified commit.
No runtime, test, package, lockfile, or build input may differ from
`b7b4279107f7e05a700c936493287a7fc391324e`.
