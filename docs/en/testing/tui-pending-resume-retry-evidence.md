# TUI Durable Pending-Resume Retry Release Evidence

## 2026-08-30 Qualification (`blade-code@0.10.123`)

- Design commit: `9c4a82ff1559b1be1ba81e72568f5c4c7df12f27`
- Implementation-plan commit: `bb447d199d2bcef1e58b57996966307881e17fef`
- Replay-boundary evidence commit: `cf20912575415ccca70599ca64c1733c112f5b29`
- Coordinator commit: `fa824d49b147980d64e121437fd90257d47852f6`
- TUI hook integration commit: `f1db9474a3f8dbc58084dd788179e76c089840b8`
- Public behavior documentation commit:
  `75cf0137dd343d7727680daa84f01cf29f19f19a`
- Real-model hook qualification commit: `747bf52d55ad1493be0ba0b5b7a465747ca37e58`
- Raw-PTY fault-injection qualification commit:
  `cf0cd6c7f61af3f6593609f88508d1cc7e22228a`
- Goal: when the TUI automatically recovers the only durable pending input, allow one
  retryable, zero-output, zero-tool-side-effect Provider failure to enter the shared bounded
  outer retry without losing the wake, replaying a side effect, or broadening retries to
  ordinary commands and Goals.

## Release boundary

- Only durable pending input may enter outer retry. Ordinary user commands, Goal-only
  continuations, preflight exceptions, and cancellations are not retried.
- The TUI directly reuses `decidePendingResumeRetry()`: at most four attempts, one absolute
  120,000ms budget, and 1s/2s/4s backoff with stable ±20% jitter.
- Retry requires a canonical retryable failure, a still-pending durable inbox,
  `outputStarted === false`, `toolExecutionStarted === false`, and
  `toolCallsCount === 0`. Missing, malformed, or contradictory evidence fails closed.
- `PendingResumeCoordinator` owns the episode, attempt, deadline, timer, generation,
  cancellation, and idle edge. `deferred` consumes no attempt and cannot spin.
- Intermediate retryable failures do not create visible assistant messages. A final failed or
  exhausted episode projects one canonical failure. The TUI adds no SSE or ACP public retry
  payload.

## Deterministic RED/GREEN evidence

Implementation was test-first. Observed REDs established the missing replay-boundary stats,
coordinator retry ownership, structured hook failure result, and two-attempt raw-PTY evidence
parser. Review-driven REDs additionally covered:

- rejected `run()` promises, synchronous scheduler/timer failures, and terminal callback
  failures;
- absolute deadlines, repeated wakes during backoff, busy-to-idle edges, disposal, and late
  results;
- disagreement between outer failures and evidence failures, and missing or invalid tool
  counts;
- Session/workspace replacement, discarded renders, and old foreground/shell completions;
- monotonic content, hidden-thinking, structured-output, and every tool-lifecycle boundary;
- valid raw-PTY polling prefixes, same-turn double terminals, unrelated terminals, a third
  attempt, duplicate acknowledgements, non-failed aborts, mismatched inboxes, successful or
  interrupted tools, and `part_updated` tool activity; and
- immediate failure when durable completion inspection throws, rather than swallowing the
  error and misreporting a timeout.

Final focused results:

- `useCommandHandler.test.tsx`: 38/38 passed;
- `PendingResumeCoordinator.test.ts`: 23/23 passed;
- `loopEventHandler.test.ts`: 53/53 passed;
- raw-PTY driver: 41/41 passed;
- raw-PTY marker latching: 63/63 passed.

## Independent review

- Event evidence, coordinator behavior, and hook integration each passed an independent
  specification review followed by a code-quality/concurrency review. Every Critical or
  Important finding received a new RED/GREEN regression and re-review. Final verdicts were
  APPROVED.
- Raw-PTY review found that the old parser rejected a valid second `turn_started` while it
  could accept abort+complete double terminals for the same turn. The new parser accepts only
  `start1 -> abort1 -> start2 -> Write -> result -> ack -> complete2`, and fails closed on
  extra terminals, a non-replay-safe first failure, or evidence-read errors. Specification and
  quality verdicts were both APPROVED.
- The real hook-test cleanup fix received separate specification and quality re-reviews; both
  verdicts were APPROVED.

## Real DeepSeek and raw-PTY qualification

Both trajectories inject one pre-stream `503` into the first
`/v1/chat/completions` request, set model `maxRetries=0`, set
`providerForegroundRecoveryMs=0`, set Vitest case `retry=0`, and pass command-line
`--retry=0`. The second HTTP request therefore can only originate from the TUI
pending-resume coordinator's outer retry.

| Model | Surface | Result | Duration | Framework retry |
| --- | --- | --- | ---: | ---: |
| `deepseek-v4-flash` | production `useCommandHandler` | passed | 3.028s | 0 |
| `deepseek-v4-pro` | production `useCommandHandler` | passed | 3.502s | 0 |
| `deepseek-v4-flash` | production CLI raw PTY | passed | 10.609s | 0 |

For both models, the hook trajectory proves request 1 was injected, request 2 was the only real
forward and completed with a 2xx response; the durable transcript contains two
`turn_started`, one `turn_aborted`, one `turn_completed`, and one
`inbox_acknowledged`; the inbox is empty; and the UI contains only the exact final marker.

The raw PTY uses the real `dist/blade.js`, `bun-pty`, and real keyboard selection and
confirmation. It proves the first failure was failed, unacknowledged, and had no tool or
persisted output; only the second attempt emitted one `Write` call/result pair, acknowledged
the inbox, and completed. Request 2 has real upstream 2xx headers, a completed body, and a
downstream-end record. No computer-use tool is available in this environment, so raw PTY is
the authoritative CLI UI surface.

Credentials are injected only through restricted environment variables. The workspace config
contains no API key; evidence scans only the transcript, fixed PTY summary, request paths, and
structured lifecycle, and records no request body, header, or secret value.

### Real-test harness failure disclosure

- The first command used the wrong package-local test path. Vitest reported
  `No test files found`; no test or Provider request ran.
- The first isolated workspace did not contain resolvable model configuration. It reported
  `model configuration not found` and issued no Provider request.
- After the configuration fix, one run waited about 111 seconds before manual interruption
  because the workspace was not trusted. The proxy saw no request and the transcript had no
  `turn_started`. A credential-free workspace config, workspace trust, and identity reset fixed
  the harness.
- On the first post-commit hook-level rerun, React 19 returned an `act()` thenable without a
  `.catch()` method. `finally` threw `act(...).catch is not a function`, masking the test-body
  result; incomplete cleanup after the first case also contaminated the second case. After
  changing cleanup to `try { await act(...) } catch {}`, the same zero-retry command passed
  Flash and Pro 2/2.

These were test-harness path, configuration, trust, or cleanup defects, not product flakes, and
no framework retry hid them. The test still reports known React warnings for external Zustand
updates not wrapped in `act(...)`; `IS_REACT_ACT_ENVIRONMENT` remains enabled and there were no
assertion failures.

## Release gates

- `bun run type-check`: CLI, VSCode, and Web all exited 0.
- `bun run lint`: CLI, VSCode, and Web all exited 0.
- `bun run build`: CLI/Web and VSCode builds exited 0. Existing non-blocking warnings remained
  for stale Browserslist data and one Web chunk larger than 500 kB.
- The first `bun run test:all` passed:
  - non-performance: 448 files passed, 91 skipped; 4,709 tests passed, 84 skipped;
  - performance: 4 files passed, 1 skipped; 9 tests passed, 1 skipped;
  - overall exit code 0 with zero failures.
- Biome on changed files and `git diff --check` both exited 0.

Qualified source hashes:

```text
ff4a3894ae49502d6280db3dbd1767b7f5bc9cc5bd6538e422ab1c8e1d358707  loopEventHandler.ts
dc23d4160d7c1a26aac669d645575884250df7b5fa4f8322ac8f897cb6932464  PendingResumeCoordinator.ts
a9dd05dc1e6488b2701cec19f3f4180930547e553b50369d1604b519c32bb5b4  useCommandHandler.ts
496ba62c727159db61b7a7001697afa929ed1278032070ab53bd74338751b788  loopEventHandler.test.ts
7f31678d518a2eaa09b40426d59e391d6fae3adc8afe8a4441ccf4d237831a1f  PendingResumeCoordinator.test.ts
b8c0724736f1397dceefd5389eef90ed183f8dad0be56fdaeda5ea28f80b638e  useCommandHandler.test.tsx
2547b1d6fc79d46b9607a0a52ccabe1724b0e5e138e87873420bea2c59feea2e  tui-durable-interaction-recovery-trajectory.test.tsx
b430c4e078e80354d3b813b2cd9bbfd77983e01fc936e00e08496267bd43fc1f  durable-interaction-recovery-trajectory.test.ts
5a1b79833413b71d9efa2efce7801d89e9e9d180b26d95c80fff4362cc5fd28c  durableInteractionRecoveryPtyDriver.ts
b430dddc1d91d4c13ba60e41f4f3e0845e4950d3e148f2a2f319adff96722d72  durableInteractionRecoveryPtyRunner.ts
d6c05f7f8c3bcf4ac9a18b768ebe6eef867deb1ab793c2556be271cd1aae4a9b  durable-interaction-recovery-pty-driver.test.ts
```

## Excluded scope

`0.10.123` contains only the TUI durable pending-input shared bounded outer retry, public
behavior documentation, deterministic regressions, and real DeepSeek/raw-PTY qualification.
The background-child completion dispatcher, Web Session projection residency, ACP remote
filesystem semantics, and long-task false-progress detection remain separate follow-up P1 work
and are not part of this patch's completion claim.
