# Bounded Foreground Provider Recovery Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.37`
- Design commit: `b1d4d956f6685ead2a2e29d61397a6642ed6dabc`
- Runtime and test commit: `f1e80c2a6927e1e9e25ea4dfe811565a91598b8f`
- Qualified release metadata commit:
  `befaefe3584af53b0e03fef246bf606d57d7344e`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`

## Result

Production qualification ran from a clean
`befaefe3584af53b0e03fef246bf606d57d7344e` worktree and passed all 16 checks.

- Unit: 3,028 passed, 1 skipped
- Full CLI suite: 3,277 passed, 71 skipped
- Web: 412 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 102 passed across 19 files

The release-blocking real-API suite completed in 1396.10s. The same production
run type-checked and linted the CLI, VS Code extension, and Web application,
verified formatting, ran the complete deterministic qualification, built the
production CLI/Web/VS Code artifacts, launched the pinned Playwright Chromium
binary, and executed the real Provider matrix.

The built CLI, `packages/cli/package.json`, and `bun.lock` all reported
`0.10.37`. `git status --porcelain=v2` was empty after qualification.

## Recovery Matrix

Every cell called a real DeepSeek Provider through a loopback transparent
proxy. The proxy returned replay-safe `503` responses for requests one through
four, held the fourth failure open for a two-second surface observation
window, and forwarded only request five to the real Provider. The same root
turn then had to inspect a fixture, change subtraction to addition with one
Edit, run one Bash test, and emit an opaque final marker.

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless JSONL | 8.628s | 0 | passed |
| DeepSeek V4 Flash | ACP stdio + child-backed terminal | 8.778s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI | 25.563s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web | 16.480s | 0 | passed |
| DeepSeek V4 Pro | Headless JSONL | 10.854s | 0 | passed |
| DeepSeek V4 Pro | ACP stdio + child-backed terminal | 11.479s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI | 27.586s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web | 18.847s | 0 | passed |

The focused eight-cell run also passed without retry in 132.45s before the
complete production qualification.

Each cell proved:

- the proxy observed exact injected attempts `1,2,3,4` before one real
  Provider request;
- the surface observed `recovered` at `4/12` with
  `mode=bounded_foreground`, a 600,000ms budget, and nonnegative monotonic
  elapsed/remaining values;
- the transcript contained one Edit call, one Bash call, one final marker,
  and one terminal turn completion;
- the source mutation occurred exactly once, the host reran `node --test`
  successfully, and the final Git diff contained only `src/add.js`;
- Headless emitted schema-validated JSONL, ACP used metadata without assistant
  text pollution, TUI rendered bounded recovery plus Esc cancellation, and
  Web rendered the StatusBar recovery state before clearing it on completion;
- Web loaded the production build in pinned Chromium, completed through real
  SSE, retained the final result after reload, and reported no application
  console error;
- the Provider proxy/socket, child process, ACP terminal, raw PTY, browser,
  page, SSE reader, server, bound port, temporary HOME/storage/workspace, and
  credential-bearing configuration were reclaimed;
- Provider keys, private injected response bodies, raw headers, and raw
  transport errors were absent from JSONL, SSE, ACP traffic, DOM, PTY capture,
  transcript, diagnostics, and retained evidence.

## Frozen Bounds

| Setting | Default | Minimum | Maximum |
| --- | ---: | ---: | ---: |
| Foreground recovery budget | 600,000ms | 30,000ms | 3,600,000ms |
| Foreground additional requests | 12 | fixed default | fixed default |
| Retry backoff cap | 60,000ms | fixed | fixed |
| Waiting heartbeat interval | 15,000ms | fixed | fixed |

`providerForegroundRecoveryMs=0` disables extended foreground recovery. Any
other configured value must be a safe integer in the documented range.

When a model has no explicit `overrides.maxRetries`, a root foreground turn
shares the default 12 additional requests across primary and fallback
candidates. An explicit override retains the existing per-candidate fallback
semantics, including `maxRetries=0`, while every candidate still shares one
absolute recovery deadline. Background subagents, verification, compaction,
health probes, and internal sampling retain the standard short retry policy.

## Proven Runtime Contract

The deterministic and real-API evidence together proves:

- only an eligible root foreground request receives the bounded recovery
  contract; subagent and internal requests cannot amplify a Provider outage;
- the monotonic recovery clock starts at the first retryable failure and
  includes backoff, connection setup, and the entire in-flight retry stream;
- every retry stream receives a child AbortSignal whose hard timer aborts the
  iterator at the absolute deadline and is cleared on every exit path;
- primary and fallback candidates cannot reset or extend the recovery clock;
- the default policy cannot exceed 12 additional physical requests, while an
  explicit retry override still reaches a configured fallback;
- backoff follows capped exponential delay and emits a typed `waiting`
  heartbeat after each complete 15-second cancellable sleep chunk;
- caller abort, TUI Esc, Web stop, ACP cancel, and coordinated shutdown cancel
  backoff or in-flight streaming without waiting for the recovery budget;
- `scheduled`, `waiting`, `attempt`, `recovered`, and `exhausted` carry one
  sanitized schema through Headless, TUI, Web SSE/store, and ACP;
- attempt-limit and recovery-budget exhaustion are distinguishable without
  leaking Provider response content;
- text, reasoning, tool call, usage, or finish is a strict replay boundary;
  no request or fallback can replay after the first real Provider chunk;
- Provider recovery options remain runtime-only and never enter model-visible
  messages, Provider payloads, durable transcript, or session replay;
- active timers return to zero after success, exhaustion, fallback, deadline,
  and caller cancellation;
- source search gates reject production bypasses, `Infinity`, test-only
  recovery switches, and unbounded foreground retry loops.

## Failure and Retry Disclosure

Development testing found and fixed four harness or compatibility defects:

- a reused Vitest mock implementation leaked retry behavior across cases;
- the raw-PTY runner initially matched the final marker echoed in the user
  prompt, so it now requires durable `turn_completed` plus post-recovery TUI
  output before cleanup;
- the proxy passed a Node `Buffer` as Fetch `BodyInit`, so JSON requests are
  forwarded as their exact UTF-8 body;
- an initial shared physical-attempt cap could prevent an explicitly
  configured primary from reaching fallback. The final runtime shares the
  attempt cap only for the new implicit 12-retry default and has a dedicated
  fallback regression.

The final recovery matrix passed all eight cells with zero framework retry in
both the focused run and full production qualification.

One pre-existing cell used its configured single retry in the final full
production run:

- durable root-turn auto-resume, DeepSeek Flash raw PTY: retry x1.

No bounded-foreground-Provider-recovery cell, Provider retry/compaction/stall
control, foreground handoff cell, tool-admission cell, shutdown cell, or
release-coding trajectory retried.

## Release Boundary

The exact runtime and test source qualified by real API is
`f1e80c2a6927e1e9e25ea4dfe811565a91598b8f`. The release metadata commit
`befaefe3584af53b0e03fef246bf606d57d7344e` changes only package and lockfile
versions and was the clean HEAD used for full production qualification. The
next commit may add only this evidence file; the tag must contain no
unqualified runtime, test, configuration, or release metadata change.
