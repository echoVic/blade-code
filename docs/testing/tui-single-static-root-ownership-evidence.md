# TUI Single Static Root Ownership Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.38`
- Runtime and regression commit:
  `c68977b76ce88cc244dfbd1f4924d24aa683404a`
- Qualified release metadata commit:
  `4d799f9eb34a3dbfdf59a5a8b9f112135d02275b`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`

## Result

Production qualification ran from a clean
`4d799f9eb34a3dbfdf59a5a8b9f112135d02275b` worktree and passed all 16
checks.

- Unit: 3,029 passed, 1 skipped
- Full CLI suite: 3,278 passed, 71 skipped
- Web: 412 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 102 passed across 19 files

The release-blocking real-API suite completed in 1677.97s. The same
qualification type-checked and linted the CLI, VS Code extension, and Web
application, verified formatting, ran the deterministic suites, built the
production artifacts, launched the pinned Playwright Chromium binary, and ran
the real Provider matrix.

The built CLI, `packages/cli/package.json`, and `bun.lock` all reported
`0.10.38`. The worktree remained clean after qualification. Independent
release-head build and test commands then passed without source changes.

## Failure Mechanism

Before this patch, `MessageArea` could mount two sibling Ink `Static` roots:

- the primary root projected durable history;
- a conditional root projected completed blocks from the active stream.

Ink 6.4.10 stores one `rootNode.staticNode` pointer. When the conditional
streaming root transitioned from populated to absent, its Yoga node could be
released while that pointer still referenced it. A later React commit entered
Ink through `resetAfterCommit -> onImmediateRender -> renderer`, then failed in
Yoga `getComputedWidth()` with:

```text
RuntimeError: memory access out of bounds
```

The production failure was reproduced twice in the DeepSeek V4 Pro
background-subagent raw PTY case. Runtime instrumentation then established a
control group:

- a passing run never populated the conditional streaming root;
- a failing run projected `streamingStaticItemCount=2`, transitioned to zero,
  and crashed before progress removal or terminal resize;
- a cleanup-only dependency experiment did not prevent the crash and was
  removed.

This ruled out Provider behavior, subagent removal timers, terminal resize,
and fatal-error projection as initiating causes.

## Ownership Contract

`MessageArea` now projects history and completed streaming blocks through one
`Static` root:

```text
allStaticItems = staticItems + streamingStaticItems
```

The existing `clearCount` remains the only remount boundary for finalization,
resize, and history reset. Raw stream tail rendering remains outside React, so
the existing bounded output, native scrollback, streaming deduplication, and
final message commit semantics are unchanged.

The regression gate reads the production component and requires:

- exactly one `<Static>` root;
- the combined projection to include both item sources;
- the sole root to use `allStaticItems`;
- the former conditional `streaming-${clearCount}` root to remain absent.

## Real API Surface Matrix

Each cell used a real DeepSeek Provider and exercised the durable
background-subagent completion wake-up through the production surface.

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless | 5.576s | 0 | passed |
| DeepSeek V4 Flash | ACP session/load | 5.496s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI | 34.078s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web | 14.770s | 0 | passed |
| DeepSeek V4 Pro | Headless | 8.434s | 0 | passed |
| DeepSeek V4 Pro | ACP session/load | 4.974s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI | 25.732s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web | 18.886s | 0 | passed |

The matrix proved that both models independently woke and completed their
parents, TUI retained its real PTY lifecycle without a Yoga fault, Web used
the production build in Chromium and survived reload, and all temporary
processes, browser profiles, ports, homes, storage roots, and workspaces were
reclaimed.

Fault-isolation verification also ran the exact DeepSeek V4 Pro raw PTY case
four consecutive times with no framework retry. One run exercised the former
failure precondition:

```text
streamingStaticItemCount: 0 -> 1 -> 2 -> 0
```

It safely completed finalization, delayed progress removal, and terminal
resize. A final no-instrumentation release-candidate run also passed with
retry disabled.

## Failure and Retry Disclosure

All eight target cells passed with zero framework retry. Three unrelated raw
PTY cells used their configured single retry in the complete production run:

- Goal finalization handoff, DeepSeek V4 Flash raw PTY: retry x1, 82.426s.
- Root-turn auto-resume, DeepSeek V4 Pro raw PTY: retry x1, 67.646s.
- Bounded foreground output, DeepSeek V4 Pro raw PTY: retry x1, 50.630s.

No target background-completion cell, Provider retry control, tool-admission
cell, foreground Provider recovery cell, graceful-shutdown cell, foreground
handoff cell, release coding trajectory, or production Web GUI cell retried.

## Release Boundary

The exact runtime and regression source qualified by real API is
`c68977b76ce88cc244dfbd1f4924d24aa683404a`. The release metadata commit
`4d799f9eb34a3dbfdf59a5a8b9f112135d02275b` changes only the package and
lockfile versions plus changelog. The next commit may add only this evidence
file; the tag must contain no unqualified runtime, test, configuration, or
release metadata change.
