# Bounded Fair Tool Admission Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.35`
- Runtime and test qualification commit:
  `527cb02b329fb15979df712ca0028597718501e7`
- Release metadata commit:
  `2a3fdc144ea253ac3f3be10bfbe758623ba368ef`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`

## Result

Production qualification passed all 16 checks.

- Unit: 2,972 passed, 1 skipped
- Full CLI suite: 3,211 passed, 71 skipped
- Web: 411 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 86 passed across 17 files

The release-blocking real-API suite completed in 1189.50s. The same production
run type-checked and linted the CLI, VS Code extension, and Web application,
verified formatting, ran the complete deterministic qualification, built the
production CLI/Web/VS Code artifacts, and launched the locked Playwright
Chromium binary successfully.

The built CLI, `packages/cli/package.json`, and `bun.lock` all reported
`0.10.35`.

## Admission Matrix

Every single-Session cell called a real DeepSeek Provider and required one
response containing four canonical foreground Bash calls. The host waited for
all four durable tool-use identities, proved that exactly two calls started,
observed structured queue progress for the remainder, and released one permit
at a time. Each release started exactly one successor. Calls and results
remained in Provider order even when filesystem persistence completed in a
different order.

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless JSONL | 6.649s | 0 | passed |
| DeepSeek V4 Flash | ACP stdio + PTY terminal | 7.987s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI | 24.003s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web | 13.811s | 0 | passed |
| DeepSeek V4 Pro | Headless JSONL | 10.423s | 0 | passed |
| DeepSeek V4 Pro | ACP stdio + PTY terminal | 11.033s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI | 27.968s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web | 17.131s | 0 | passed |
| DeepSeek V4 Flash | two-Session Chromium fairness | 18.325s | 0 | passed |

The focused nine-test admission run also passed without retry in 138.06s
before the complete production qualification.

The two-Session Chromium trajectory held two Session A Bash calls active and
queued A's third call. Session B then used the third process-wide execute slot,
completed before A produced any result, and survived reload independently.
Releasing each A permit advanced exactly one queued A call. Both durable
transcripts survived reload, and all server, browser, SSE, port, lease, process,
credential, and temporary-root resources were reclaimed.

## Frozen Bounds

The qualified runtime freezes the following limits:

| Scope | Total | readonly | write | execute | Pending |
| --- | ---: | ---: | ---: | ---: | ---: |
| Process | 32 | 24 | 8 | 3 | 256 |
| Session | 10 | 8 | 4 | 2 | 64 |

- Admission wait timeout: 180 seconds
- Tool calls accepted from one Provider response: 64
- Shared/exclusive gate pending work: 64

Each execution must simultaneously satisfy Session total, Session kind,
process total, and process kind capacity. A Session therefore cannot consume
all three execute slots. Eligible Sessions are selected round-robin while each
Session preserves arrival order; a locally saturated Session cannot block a
peer that still fits global capacity.

## Proven Runtime Contract

The deterministic and real-API evidence together proves:

- every queued item has stable `ownerId`, `sessionId`, kind, abort listener,
  timeout, and typed admission outcome;
- Session and process totals are independent of kind counters, including
  mixed-kind saturation where the total limit is the actual constraint;
- queue overflow and wait timeout return retryable
  `resource_exhausted/tool_busy` results with exact reason, scope, kind, and
  limit rather than throwing an untyped runtime failure;
- queued abort, timeout, owner disposal, and scheduler close synchronously
  remove the item and its listener/timer before draining the next eligible
  Session;
- `ToolExecutor.dispose()` cancels only its own owner queue, closes its local
  concurrency gate idempotently, and rejects future execution without
  disturbing other executors in the same Session;
- the shared/exclusive gate retains its FIFO barrier, bounds pending work at
  64, reports typed overflow/closed failures, and removes AbortSignal
  listeners on start, abort, timeout, overflow, and close;
- the 65th and later tool call in one Provider response receives one
  `tool_batch_full` result per Provider call ID without entering durable
  identity persistence, policy, the local gate, or the process scheduler;
- streaming discard/fallback resets the turn admission generation, while the
  streaming and non-streaming paths enforce the same 64-call contract;
- durable tool-use identities commit in Provider order before their external
  executions race; no-storage execution keeps its synchronous allowlisted
  prelaunch behavior;
- queue progress retains kind, scope, position, in-flight count, and limit
  through Headless JSONL, TUI state, Web SSE/store, and ACP
  `tool_call_update`;
- Bash replay sanitization retains only the allowed typed admission metadata
  and removes unknown or malformed fields;
- production Chromium renders queued tool cards from real SSE data, while
  reload reconstructs the same durable terminal state;
- every real-API cell leaves zero foreground lease, active marker, child
  process, ACP terminal, raw PTY, browser/page, SSE reader, server, or bound
  port;
- Provider credentials are absent from JSONL, transcripts, logs, browser
  output, ACP traffic, PTY capture, diagnostics, and retained evidence.

## Failure and Retry Disclosure

Harness development exposed and fixed three production-relevant failures:
concurrent `saveToolUse()` completion could reorder durable call identities;
Bash metadata sanitization discarded typed admission failures; and the Web
assertion inspected a collapsed group summary instead of the individual queued
cards. The final harness serializes identity commits only, preserves strict
metadata, expands the production tool group, and independently observes SSE
and DOM projections.

All nine final admission tests passed with zero retry both in the focused run
and in production qualification.

One pre-existing `graceful-shutdown` DeepSeek Flash raw-PTY trajectory failed
its first attempt and passed its configured single retry in the final full
production run. No admission cell, admission cleanup assertion, two-Session
fairness assertion, or release coding trajectory retried.

## Release Boundary

The exact runtime and test source qualified by real API is
`527cb02b329fb15979df712ca0028597718501e7`. The release metadata commit
`2a3fdc144ea253ac3f3be10bfbe758623ba368ef` changes only package/lockfile
version and user/release documentation, then passed the full production
qualification. The tag may add only this evidence file after that commit.
