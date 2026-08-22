# Bounded Ordered Surface Egress Release Evidence

- Date: 2026-08-14
- Version: `blade-code@0.10.33`
- Runtime and test qualification commit:
  `a5ff0005fc06ca83e82200d898863bd51e668bbb`
- Release metadata commit:
  `f99c34f8da02cbfa0f10f787b8c7665f1368c8f3`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`

## Result

Production qualification passed all 16 checks.

- Unit: 2,931 passed, 1 skipped
- Full CLI suite: 3,170 passed, 70 skipped
- Web: 411 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 69 passed across 15 files

The release-blocking real-API suite completed in 924.74s. The release metadata
commit then built successfully, passed the complete deterministic CLI suite,
and both the built CLI and `packages/cli/package.json` reported `0.10.33`.

## Surface Egress Matrix

Every cell called a real Provider and one real foreground Bash while exercising
the surface-specific consumer boundary:

| Model | Surface | Injected boundary | Duration | Result |
| --- | --- | --- | ---: | --- |
| DeepSeek V4 Flash | Headless | stdout/stderr `write(false)` + delayed drain | 4.470s | passed |
| DeepSeek V4 Flash | ACP | delayed `sessionUpdate()` | 15.099s | passed |
| DeepSeek V4 Flash | raw PTY TUI | host reader pause/resume | 18.067s | passed |
| DeepSeek V4 Flash | production Chromium Web | reload during run + fresh reload | 21.760s | passed |
| DeepSeek V4 Pro | Headless | stdout/stderr `write(false)` + delayed drain | 5.424s | passed |
| DeepSeek V4 Pro | ACP | delayed `sessionUpdate()` | 11.770s | passed |
| DeepSeek V4 Pro | raw PTY TUI | host reader pause/resume | 35.182s | passed |
| DeepSeek V4 Pro | production Chromium Web | reload during run + fresh reload | 20.613s | passed |

All eight cells passed without a test retry.

## Proven Runtime Contract

The deterministic and real-API evidence together proves:

- one shared FIFO primitive counts the active write and queued items against
  independent 256-item and 8 MiB limits;
- UTF-8 byte accounting, oversized items, overflow, abort, writer rejection,
  30-second write timeout, idempotent close, and flush high-water semantics
  fail closed without unhandled rejection;
- stdout and stderr have independent Headless capacity, `write(false)` waits
  for `drain`, and no second raw write starts while the first is blocked;
- Headless waits for the final frame before returning and removes every
  drain/error/abort listener after success, `EPIPE`, timeout, or cancellation;
- one ACP Session has exactly one underlying `sessionUpdate()` path and at most
  one update in flight across content, thinking, tool, slash-command,
  user-shell, and metadata updates;
- ACP backpressure pauses the Agent generator; timeout and overflow cancel the
  current work without a synthetic user message;
- Web subscribes before replay, serializes every `writeSSE()`, and atomically
  cuts over from committed-sequence replay to live delivery;
- duplicate/replayed sequence numbers are removed, sequence regression fails
  closed, and heartbeat cannot displace ordinary events;
- one slow Session or global subscriber is evicted without blocking a fast
  peer or cancelling the server-owned Agent run;
- Web Store opens and buffers EventSource before fetching the durable snapshot,
  then performs one final authoritative history resync without duplicate DOM
  replacement;
- TUI remains a local projection and continues rendering after raw PTY reader
  consumption resumes;
- static writer gates leave one low-level ACP writer, one Web SSE adapter per
  route, and one raw Headless writable call.

## Failure and Retry Disclosure

The first full production attempt at `1af43232` passed 68 of 69 real-API tests.
The new bounded-egress matrix passed all eight cells without retry. An existing
leaderless foreground-process test failed both configured attempts because the
real model rewrote nested shell quoting in an inline `bun -e` program; the
background child exited before its host-visible PID barrier.

The fixture-only commit `a5ff0005` moved the same PID write, SIGTERM behavior,
delayed side effect, and persistent event loop into a parameterized child
program. It did not weaken the real Bash, durable lease, owner hard-kill, cold
reaper, process-group, or forbidden-side-effect assertions. The focused real
API rerun passed without retry in 9.493s, and the final full qualification
passed the same trajectory without retry in 8.789s.

One pre-existing permission-mode Headless trajectory passed after one
configured retry in the final full run. The new bounded-egress eight-cell
matrix, the stabilized leaderless trajectory, and every other final trajectory
passed without retry.

## Release Boundary

The exact runtime and test source qualified by real API is
`a5ff0005fc06ca83e82200d898863bd51e668bbb`. The release metadata commit changes
only the package/lockfile version and user/release documentation, then passes
the full build and deterministic suite. The tag may add only this evidence
file after `f99c34f8da02cbfa0f10f787b8c7665f1368c8f3`.
