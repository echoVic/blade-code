# Active Turn Activity Qualification Evidence

- Date: 2026-09-05
- Target version: `blade-code@0.10.138`
- Implementation and real-API qualification baseline: `3ec02e87b17b61d081eefec27544adf1b35eb33f`
- Real-API command: `REAL_API_TEST=1 REAL_API_RELEASE_MATRIX=1 bunx vitest run --config vitest.config.ts --project=real-api tests/integration/real-api/turn-activity-surface-trajectory.test.ts`
- Deterministic surface command: `bunx vitest run --config vitest.config.ts --project=integration tests/integration/turn-activity-surfaces.test.ts`

## Result

Runtime now owns active-turn state and projects one generation/revision stream through Headless, real ACP stdio, raw PTY TUI, and production Chromium Web.

| Model | Headless | ACP | raw PTY TUI | production Web |
| --- | ---: | ---: | ---: | ---: |
| `deepseek-v4-flash` | 7.897s | 7.245s | 8.896s | 12.352s |
| `deepseek-v4-pro` | 8.384s | 9.064s | 10.473s | 14.953s |

The real-API matrix passed `8/8` in 80.42s. Vitest retry and model retry were disabled for every cell. Each cell made exactly two real Provider requests: one produced a single Bash tool call and the next returned the exact marker.

The deterministic production TUI/Web trajectory passed `2/2` three consecutive times. Web reloads while a host barrier keeps the tool active, restores `executing_tools` and Bash from the SSE connected frame, and removes the strip after completion. Raw PTY evidence directly observes thinking, active Bash, tool/turn counters, elapsed time, and the terminal return to the composer.

## Covered contracts

- Runtime generation/revision fencing, parallel tools, eight-item bound, numeric progress, compaction, continuation, explicit clear, and non-finite turn limits;
- TUI and Web phases, tools, counters, elapsed time, and specialized-state precedence;
- Web revision-0 anchoring, authoritative reconnect hydration, terminal/navigation cleanup, and preservation of the generation when an assistant message starts;
- ACP initial/live `blade/turnActivity`, duplicate-revision suppression, and terminal clear;
- closed-schema Headless JSONL `turn_activity` and terminal clear;
- no tool arguments, commands, output, paths, prompts, errors, URLs, progress messages, or API keys in public activity.

## Gate record

- `bun run build && bun run type-check && bun run lint`: passed; CLI lint checked 1401 files and Web lint checked 208 files.
- First `bun run test:all`: 5749 passed, 88 skipped, 2 failed. `raw-pty-marker-latching.test.ts` failed deterministically because the new runner was not inventoried, then the inventory was fixed. The unchanged cross-process capacity case in `remote-workspace-reference.test.ts` passed on its exact rerun.
- After freezing `0.10.138` metadata, `bun run test:all` passed 494 files and 5754 tests with 98 files and 88 tests skipped in the non-performance stage; performance passed 4 files and 9 tests with one file and one test skipped, in 364.06s total.
- `bun run test:coverage` passed 494 files and 5754 tests with 98 files and 88 tests skipped; global coverage was 73.78% statements, 67.17% branches, 75.65% functions, and 75.16% lines, exit code 0.
- `bun run test:web` passed 69 files and 662 tests. Separate Web coverage fails while loading the provider because the repository currently resolves `vitest@3.2.7` with root `@vitest/coverage-v8@4.1.10`; this environment mismatch is not reported as a passing gate.

## Cleanup and privacy

All trajectories use random temporary roots, ports, and Session IDs. Provider proxies, SSE readers, browser/page objects, ACP connections, PTYs, servers, and temporary directories close in `finally`. Runner child environments remove unrelated credential variables and inject only the credential needed by that Blade child. Assertions scan JSONL, ACP updates, PTY projections, DOM/server output, and transcripts; no credential was observed.
