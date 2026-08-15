# Bounded Coordinated Runtime Shutdown Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.34`
- Runtime and test qualification commit:
  `db1773d72c6f53847b241ad59277e5cd37fb2a87`
- Release metadata commit:
  `7d69569991eafaa7601348f9eaed1f8537a2bcbe`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`

## Result

Production qualification passed all 16 checks.

- Unit: 2,939 passed, 1 skipped
- Full CLI suite: 3,178 passed, 70 skipped
- Web: 411 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 77 passed across 16 files

The release-blocking real-API suite completed in 1097.76s. The release metadata
commit then rebuilt successfully, passed the complete deterministic CLI suite,
and the built CLI, `packages/cli/package.json`, and `bun.lock` all reported
`0.10.34`.

## Graceful Shutdown Matrix

Every cell called a real Provider, started one real foreground Bash, waited for
the host-visible child PID barrier, and then sent the production shutdown
signal. The same durable Session was subsequently resumed through production
Headless.

| Model | Surface | Shutdown boundary | Duration | Result |
| --- | --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless | invocation-local `SIGTERM` owner | 19.179s | passed |
| DeepSeek V4 Flash | ACP | stdio Agent + Bun PTY terminal `SIGTERM` | 22.370s | passed |
| DeepSeek V4 Flash | raw PTY TUI | direct OS `SIGTERM` to TUI PID | 35.778s | passed |
| DeepSeek V4 Flash | production Chromium Web | `blade serve` process `SIGTERM` | 18.086s | passed |
| DeepSeek V4 Pro | Headless | invocation-local `SIGTERM` owner | 27.535s | passed |
| DeepSeek V4 Pro | ACP | stdio Agent + Bun PTY terminal `SIGTERM` | 20.003s | passed |
| DeepSeek V4 Pro | raw PTY TUI | direct OS `SIGTERM` to TUI PID | 33.983s | passed |
| DeepSeek V4 Pro | production Chromium Web | `blade serve` process `SIGTERM` | 19.713s | passed |

All eight shutdown cells passed without a test retry. A separate focused
eight-cell run also passed without retry in 240.25s before the full production
qualification.

## Proven Runtime Contract

The deterministic and real-API evidence together proves:

- Agent operation admission closes synchronously; every admitted
  `chatStream()` owns a combined AbortSignal and releases its lease only after
  turn finalization;
- concurrent `Agent.destroy()` calls share one abort-and-idle barrier, and
  ToolExecutor/MCP disposal cannot overtake an active generator's durable
  `finishTurn()`;
- TUI process shutdown synchronously aborts the active command before React
  cleanup, SessionEnd hooks, logger shutdown, terminal restore, and process
  exit;
- the global five-second hard failsafe and four-second cleanup phase are
  cleared after successful shutdown and do not fire late;
- Web route shutdown rejects new mutations with `503`, captures run,
  user-shell, review, Runtime-initialization, and Runtime-disposal completion,
  and disposes each Runtime once;
- `blade web` and `blade serve` register the server as a process cleanup owner;
  task scheduler, stale-session GC, listeners, Runtime maps, and shared MCP are
  drained under one idempotent stop Promise;
- ACP prompt and user-shell completion are awaited before Agent, Runtime, and
  service-context disposal; BladeAgent and AcpSession concurrent destroy calls
  share one Promise;
- normal shutdown writes exactly one
  `turn_aborted(cause="cancelled")`, does not write `turn_completed`, and leaves
  the original durable input resumable;
- the resumed turn sees the canonical `<turn_aborted>` history, does not launch
  the foreground Bash again, emits the expected marker, and writes one
  `turn_completed`;
- a TERM-ignoring child and its leaderless process group are gone, durable
  foreground leases are empty, and the delayed forbidden side effect never
  occurs;
- browser/page, SSE, server, port, raw PTY, ACP connection, terminal process,
  Session lease, temporary HOME/storage/workspace/trust roots, and process
  trees are reclaimed for every cell;
- Provider credentials are absent from JSONL, logs, browser output, raw PTY
  capture, ACP traffic, diagnostics, and retained test evidence.

## Failure and Retry Disclosure

During harness development, the first Headless attempt incorrectly required a
zero exit code even though Headless interruption intentionally returns a
non-zero result. Its in-process resume also reused the Vitest Store. The final
harness uses a fresh production Headless process and validates the durable
protocol rather than that incorrect exit-code assumption.

The initial raw-PTY harness used `terminal.kill("SIGTERM")`, which closes the
PTY but is not equivalent to sending an OS signal to the TUI Node PID. The
final matrix uses `process.kill(pid, "SIGTERM")`; all eight final cells passed
without retry.

One pre-existing Goal-finalization Flash raw-PTY trajectory passed after one
configured retry in the final full production run. The new shutdown matrix and
all its resource, durability, delayed-side-effect, and credential assertions
passed without retry.

## Release Boundary

The exact runtime and test source qualified by real API is
`db1773d72c6f53847b241ad59277e5cd37fb2a87`. The release metadata commit
`7d69569991eafaa7601348f9eaed1f8537a2bcbe` changes only package/lockfile
version and user/release documentation, then passes the full build and
deterministic suite. The tag may add only this evidence file after that commit.
