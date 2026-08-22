# Bounded Shared Provider Circuit Breaker Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.39`
- Design commit: `65ca6237cc197e36e38dfa305c0a8a7f4f02ab1e`
- Runtime and test commit: `00cd236ac6d15cdd11dd66d2ff3841be6900a33d`
- Qualified release metadata commit:
  `49536530a4604187150b04a42ff044f3c746eeac`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`

## Result

Production qualification ran from a clean
`49536530a4604187150b04a42ff044f3c746eeac` worktree and passed all 16
checks.

- Unit: 3,086 passed, 1 skipped
- Full CLI suite: 3,336 passed, 71 skipped
- Web: 414 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 102 passed across 19 files

The release-blocking real-API suite completed in 1473.24s. The same
qualification type-checked and linted the CLI, VS Code extension, and Web
application, verified formatting, ran the deterministic suites, built the
production artifacts, launched the pinned Playwright Chromium binary, and ran
the complete real Provider matrix.

The focused shared-circuit matrix passed all eight cells with zero framework
retry in 152.48s before the complete production qualification. The full
production run also completed with zero framework retry.

## State and Ownership Contract

One process-wide registry coordinates failures by Provider failure domain.
Each entry follows:

```text
Closed -> Open -> HalfOpen -> Closed | Open
```

The frozen policy is:

| Bound | Value |
| --- | ---: |
| Sliding window | 60,000ms |
| Minimum samples | 4 |
| Failure-rate threshold | 80% |
| Default Open interval | 10,000ms |
| Configured Open interval | `0` or 1,000-300,000ms |
| Concurrent HalfOpen probes | 1 |
| Probe lease | 300,000-600,000ms |
| Registry entries | 128 |
| Samples per failure domain | 256 |
| Idle Closed TTL | 1,800,000ms |
| Waiting heartbeat | 15,000ms |

`providerCircuitBreakerOpenMs=0` preserves the pre-0.10.39 request behavior.
All other configured values must be safe integers in the documented range.
An active Session uses its frozen configuration snapshot.

Open/window/lease decisions use a monotonic clock. Wall time is used only to
project the sanitized `nextProbeAt` UI hint. The registry performs
lookup-driven cleanup without an interval timer. Capacity pressure evicts
Closed LRU entries first; Open and HalfOpen entries remain owned. If every
entry is active, a new domain receives a no-op handle instead of exceeding the
hard bound or evicting outage state.

Every physical attempt receives an opaque token retained in a `WeakMap`.
HalfOpen ownership additionally binds generation and lease identity:

- same-tick checks admit exactly one probe;
- caller abort, foreground deadline, and stream idle timeout abandon the
  probe synchronously;
- lease expiry permits exactly one takeover;
- stale success, failure, neutral, or abandon from an old owner cannot mutate
  the replacement generation;
- probe success or a request-specific neutral Provider response closes the
  circuit;
- a retryable probe failure reopens it.

The first real Provider chunk records success and crosses the replay boundary.
A later stream failure is surfaced without replay and cannot be rewritten as a
zero-output circuit failure.

## Failure Domain and Outcome Classification

Failure-domain identity covers:

```text
provider channel
wire API
canonical base URL
model
service tier
API version or deployment
explicit credential
custom routing headers
configured Open policy
```

Credential and routing-header values enter only an HMAC-SHA-256 digest driven
by a process-random 32-byte secret. The digest and sensitive source values are
absent from logs, surface events, Provider-visible messages, transcripts, and
persistent configuration.

Circuit failures include replay-safe `429`, retryable `5xx` including `529`,
pre-output transport failure, and pre-output stream closure. Caller abort,
foreground budget expiry, stream idle timeout, and local pre-response errors
are abandoned rather than counted. Context/request-size, auth, billing,
quota, deterministic `4xx`, and other request-specific Provider responses are
neutral.

## Foreground and Fallback Contract

An Open non-terminal candidate emits `rejected` and falls through without a
Provider request. An Open terminal candidate in an eligible root foreground
turn waits only within the existing absolute
`providerForegroundRecoveryMs` deadline, emits a typed waiting heartbeat, and
competes for the single probe.

Background, internal, verification, compaction, health, and standard requests
fail fast with `ProviderCircuitOpenError`; they remain fallback-eligible but
cannot retry the same known-bad candidate. Retry backoff and circuit delay use:

```text
effectiveDelay = max(retryBackoff, circuitRetryAfter)
```

They are never added, and neither circuit wait nor fallback can reset or
extend the original foreground recovery deadline.

The typed `opened`, `waiting`, `probe`, `closed`, `reopened`, and `rejected`
lifecycle is projected through Headless JSONL, TUI, Web SSE/StatusBar, ACP
metadata, and subagent SSE. Completion, cancellation, error, reload, and task
reset clear transient circuit state.

## Real API Surface Matrix

Every cell called a real DeepSeek Provider through a loopback transparent
proxy. Requests one through four received replay-safe `503` responses. The
fourth failure opened the shared circuit; the proxy then required an
observable Open interval with zero Provider requests, one HalfOpen owner, and
one real Provider request after the interval.

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless JSONL | 8.915s | 0 | passed |
| DeepSeek V4 Flash | ACP stdio + child-backed terminal | 9.511s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI | 25.213s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web | 16.522s | 0 | passed |
| DeepSeek V4 Pro | Headless JSONL | 15.319s | 0 | passed |
| DeepSeek V4 Pro | ACP stdio + child-backed terminal | 15.134s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI | 32.872s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web | 23.475s | 0 | passed |

Each cell then completed the same coding task with exactly one Edit, one Bash
verification, and one final marker. Host verification proved the mutation
occurred once and the fixture test passed.

For both models, the Web and ACP cells also used two concurrent Sessions in
one production process:

- Session A tripped the shared failure domain;
- Session B submitted while the circuit was Open;
- Session B generated zero Provider traffic before admission;
- both Sessions observed the sanitized waiting state;
- exactly one Session owned the first HalfOpen probe;
- probe success closed the shared circuit;
- both Sessions then obtained independent real Provider results;
- no Session identity, transcript, cancellation, or event crossed ownership
  boundaries.

Headless emitted schema-validated JSONL. ACP used typed metadata without
assistant-text pollution. TUI rendered bounded waiting/probe status and
retained Esc cancellation through a real raw PTY. Web loaded the production
build in pinned Chromium, observed the circuit in the StatusBar, completed
through real SSE, survived reload, and reported no application console error.

The Provider proxy/socket, child process, ACP terminal, raw PTY, browser,
page, SSE reader, server, bound port, temporary HOME/storage/workspace, and
credential-bearing configuration were reclaimed after every cell.

## Deterministic and Regression Coverage

Focused deterministic suites proved:

- state-machine threshold, sliding-window eviction, monotonic time, retry
  directives, and configured Open-policy restoration;
- exact single-probe admission, abandon, lease takeover, and stale-result
  rejection;
- hard registry/window bounds, Closed LRU eviction, active-entry retention,
  and no-op saturation behavior;
- HMAC isolation across model, endpoint, tier, API version, credential,
  routing header, and policy;
- failure/neutral classification, first-chunk replay boundary, fallback, and
  terminal-candidate deadline behavior;
- 15-second circuit heartbeat and `max(backoff, circuit)` scheduling;
- identical Headless, TUI, Web, ACP, and SSE schemas plus terminal-state
  cleanup;
- source gates against raw identity leaks, unbounded maps/windows, production
  bypasses, wall-clock admission, and model-visible runtime controls.

The focused core suites passed 80 tests, the focused runtime/surface suites
passed 312 tests, Web circuit projection passed 48 tests, and configuration
integration passed 17 tests. Full local qualification passed 14/14 checks
before the clean-head Production Qualification.

The release-blocking control matrix also passed graceful shutdown, bounded
foreground output, fair tool admission, foreground command handoff,
root-turn auto-resume, subagent result adoption, Goal finalization,
background-subagent completion, Provider retry/stall/crash recovery,
permission recovery, Goal verification, code review, durable interaction
recovery, release coding, ACP model switching, structured output, action
stationarity, and the production Agent coding trajectory.

In particular:

- background-subagent completion passed DeepSeek Flash/Pro across Headless,
  ACP, raw PTY, and production Chromium Web without the former Yoga crash;
- root-turn auto-resume, Goal finalization, and bounded foreground output all
  passed their prior retry control cells without framework retry;
- the complete run had no TUI fatal error, browser console error, leaked
  process, retained profile, or retry-assisted pass.

## Failure and Retry Disclosure

Development testing found and corrected:

- idle timeout after HTTP 200 but before the first chunk initially closed a
  probe; it now abandons ownership;
- waiting initially emitted one heartbeat; long waits now re-project every 15
  seconds;
- injected registry/window options could exceed production limits; hard
  constants now cap them;
- a Web harness assumed Session A would always own the probe; it now verifies
  exactly one owner across both Sessions;
- the TUI harness matched obsolete retry text; it now observes circuit
  waiting/probe lifecycle.

The focused eight-cell matrix and the complete 102-test production run passed
with zero framework retry. There were no retry-assisted target or control
cells to disclose.

## Release Boundary

The exact design is
`65ca6237cc197e36e38dfa305c0a8a7f4f02ab1e`. The exact runtime, tests, docs,
and configuration qualified by real API are
`00cd236ac6d15cdd11dd66d2ff3841be6900a33d`. The release metadata commit
`49536530a4604187150b04a42ff044f3c746eeac` changes only package/lockfile
version and target-version references and was the clean HEAD used for full
Production Qualification.

The next commit may add only this evidence file. The `v0.10.39` tag must
contain no unqualified runtime, test, configuration, or release metadata
change.
