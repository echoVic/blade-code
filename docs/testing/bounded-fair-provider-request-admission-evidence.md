# Bounded Fair Provider Request Admission Release Evidence

- Date: 2026-08-16
- Version: `blade-code@0.10.40`
- Design commit: `1def3c69df70c99478b3740112108619ce9d3ce5`
- Runtime and test commit: `852c8cbab5b115c17ad6d286276d45d2198495ee`
- Qualified release metadata commit:
  `d3e4642347e47cc5c10b1ec0d6ff79922d2dfcbb`
- Production command: `bun run qualify:production`
- Release-head commands: `bun run build`, `bun run test:all`

## Result

The final Production Qualification ran from a clean
`d3e4642347e47cc5c10b1ec0d6ff79922d2dfcbb` worktree and passed all 16
checks.

- Unit: 3,139 passed, 1 skipped
- Integration: 172 passed
- CLI: 8 passed
- Headless runtime: 290 passed
- End-to-end: 14 passed
- Snapshot: 9 passed
- Security: 38 passed
- Web: 416 passed
- Performance: 7 passed, 1 skipped
- Chromium preflight: passed
- Release-blocking real API: 106 passed across 21 files

The release-blocking real-API suite completed in 1676.80s. The same
qualification type-checked and linted the CLI, VS Code extension, and Web
application, verified formatting, built the production artifacts, launched
the pinned Playwright Chromium binary, and ran the complete real Provider
matrix.

All 12 Provider-admission target and control cells passed without framework
retry. The complete production run passed with two framework retries in the
pre-existing bounded-output raw PTY control. Both exact cells then passed
independently with `--retry=0`; the complete retry disclosure is below.

## Frozen Bounds

One process-wide scheduler admits every primary, retry, fallback, and
HalfOpen-probe physical stream before Provider traffic starts.

| Bound | Value |
| --- | ---: |
| Default active streams per failure domain | 4 |
| Configured per-domain range | 1-16 |
| Global active streams | 16 |
| Active streams per root owner | 3 |
| Global non-foreground active streams | 12 |
| Non-foreground active streams per owner | 2 |
| Global internal active streams | 2 |
| Internal active streams per domain | 1 |
| Global pending tickets | 128 |
| Pending tickets per domain | 32 |
| Pending tickets per owner | 16 |
| Default admission deadline | 180,000ms |
| Configured deadline | 0 or 1,000-600,000ms |
| Queue heartbeat | 15,000ms |
| Priority aging interval | 30,000ms |

`providerRequestConcurrency` cannot disable the active bound.
`providerRequestAdmissionMs=0` means fail fast when capacity is unavailable.
An active Session uses its frozen configuration snapshot.

Global pending capacity is checked before creating domain or owner state.
Queue-full rejection allocates no timer or abort listener. Idle accounting is
removed synchronously, active permits release idempotently, and
process/session cleanup cannot close the process-wide scheduler while another
Session still owns work.

## Ownership and Fairness

The root Session ID is the admission owner. Task and Team descendants,
nested children, background resumes, and private AgentSession sidecars retain
that same owner. Legacy sidecars use the immediate parent only as a runtime
fallback. The owner is absent from public Session projection and JSONL
transcripts.

Requests have one explicit class:

```text
foreground
background
internal
```

Root turns and root-blocking compaction are foreground. Task/Team children,
verification, and PromptHook sampling are background. Provider health and
other non-user-blocking sampling are internal.

Non-foreground work cannot consume the final global, owner, or domain
foreground reservation. Each owner contributes only its highest effective
priority eligible ticket; equal-priority tickets preserve owner-local FIFO,
and owners are selected by stable round-robin. Every complete 30-second wait
raises a ticket by one class rank without a sweep timer.

Caller abort synchronously removes the exact queued ticket and preserves the
caller reason. Timeout, queue-full, and scheduler-close failures use the
sanitized `PROVIDER_ADMISSION_BUSY` contract without endpoint, credential,
HMAC, owner, or Session identity.

## Permit and Circuit Ordering

Failure-domain identity covers Provider channel, wire API, canonical base
URL, model, service tier, API version or deployment, explicit credential,
custom routing headers, and admission policy. Sensitive values enter only an
HMAC-SHA-256 digest driven by an admission-specific process-random secret.

The physical request order is:

```text
circuit preflight
Provider admission ticket
permit acquired
atomic circuit check
physical Provider iterator
circuit outcome
probe abandon and permit release
```

`preflight()` is read-only. Known Open or live HalfOpen work does not occupy
Provider capacity. A matured probe is claimed only after capacity exists. If
the circuit changes while a request is queued, the post-permit `check()`
releases the permit and sends zero Provider traffic.

The permit covers first chunk, usage, finish, EOF, error, and caller iterator
return. Retry sleep, circuit wait, and fallback selection hold no permit.
Queue wait does not increment physical attempts. If the foreground recovery
deadline wins, the existing recovery-budget terminal event remains
authoritative instead of being rewritten as an admission timeout.

## Surface Contract

The typed `queued`, `admitted`, and `rejected` lifecycle is projected through:

- Headless `provider_admission` JSONL;
- TUI capacity status with queue depth and elapsed wait;
- Web `provider.admission` and `subagent.provider.admission` SSE plus
  StatusBar;
- ACP `blade/providerAdmission` metadata;
- root and subagent loop events.

Action stationarity remains highest priority, followed by circuit, Provider
admission, Provider retry, Provider stall, and ordinary state. Admission
metadata contains only class, scope, reason, queue position/depth, in-flight
count, limit, wait, deadline, and optional recovery time. Completion,
cancellation, error, reload, and task reset clear the transient projection.
No assistant-text chunk, Provider payload, durable transcript, credential, or
owner identity carries admission controls.

## Real API Matrix

Every admission proof called a real DeepSeek Provider through a loopback
recording proxy with `providerRequestConcurrency=1`. The first matching
request was held for 10 seconds. The second request had to emit a typed queue
event while producing zero proxy traffic, then start only after release.
Every cell proved a maximum same-domain in-flight count of one.

### Parent and Child Controls

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | Headless parent-child | 17.892s | 0 | passed |
| DeepSeek V4 Flash | ACP durable wake control | 5.911s | 0 | passed |
| DeepSeek V4 Flash | raw PTY TUI parent-child | 30.522s | 0 | passed |
| DeepSeek V4 Flash | production Chromium Web parent-child | 29.698s | 0 | passed |
| DeepSeek V4 Pro | Headless parent-child | 19.384s | 0 | passed |
| DeepSeek V4 Pro | ACP durable wake control | 5.688s | 0 | passed |
| DeepSeek V4 Pro | raw PTY TUI parent-child | 38.743s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web parent-child | 29.768s | 0 | passed |

The ACP cells above retain their existing durable wake-up responsibility.
Headless, raw PTY, and production Web additionally prove root/descendant
owner sharing and queued-to-admitted release.

### Independent Root Session Controls

| Model | Surface | Duration | Retry | Result |
| --- | --- | ---: | ---: | --- |
| DeepSeek V4 Flash | production Chromium Web, two Sessions | 30.876s | 0 | passed |
| DeepSeek V4 Pro | production Chromium Web, two Sessions | 40.989s | 0 | passed |
| DeepSeek V4 Flash | real ACP stdio, two Sessions | 26.525s | 0 | passed |
| DeepSeek V4 Pro | real ACP stdio, two Sessions | 27.340s | 0 | passed |

Session A owned the held request. Session B submitted through the real Web
composer or ACP connection, observed queued metadata, and generated no
Provider request before A released. Both Sessions then received independent
real Provider results and retained independent transcripts.

Web loaded the production build in pinned Chromium, observed both DOM
StatusBar and SSE state, survived reload, cleared admission state after
reload, and reported no application console or page error. ACP projected
metadata without assistant-text pollution and cleared it at terminal state.
The raw PTY cells observed the live Chinese capacity message rather than
requiring a transient line to remain in the final screen projection.

The proxy, socket, child process, ACP terminal, raw PTY, browser, page, SSE
reader, server, bound port, temporary HOME/storage/workspace, and
credential-bearing configuration were reclaimed after each cell.

## Deterministic and Regression Coverage

Deterministic tests prove:

- global, domain, owner, non-foreground, and internal active hard limits;
- global, domain, and owner pending hard limits before retained allocation;
- foreground reservation at default and configured concurrency one;
- owner round-robin, owner-local FIFO, class priority, and bounded aging;
- caller abort, wait timeout, queue close, idempotent release, and idle-state
  cleanup;
- HMAC isolation across every failure-domain dimension;
- permit lifetime through the complete async iterator and release before
  retry, circuit wait, or fallback;
- no attempt increment while queued, 15-second heartbeat, and recovery
  deadline precedence;
- circuit preflight, post-queue race, one HalfOpen owner, and zero traffic
  after a blocked recheck;
- root, descendant, nested resume, and legacy sidecar owner propagation;
- identical Headless, TUI, Web, ACP, root SSE, and subagent SSE schemas and
  terminal cleanup;
- source gates against unbounded state, raw identity leaks, transcript
  persistence, Provider-visible controls, and production bypasses.

The complete control suite also kept Provider retry, shared circuit, stream
stall, compaction, bounded output, foreground handoff, graceful shutdown,
Goal, subagent recovery/adoption, permission recovery, code review,
structured output, action stationarity, and the production coding trajectory
green.

## Failure and Retry Disclosure

The first clean-head Production Qualification reached the real-API gate and
finished with 20 of 21 files and 105 of 106 tests passing. It disclosed:

- Goal-finalization DeepSeek Pro raw PTY: passed with `retry x1`;
- permission recovery ACP cold start: passed with `retry x1`;
- permission recovery Headless cold start: passed with `retry x1`;
- bounded-output DeepSeek Pro raw PTY: failed after `retry x1`.

The terminal bounded-output error was:

```text
Timed out waiting for TUI composer
output=""
```

It occurred before the coding prompt or Provider request. The run is retained
as failed evidence and is not counted as the release qualification.

Fresh exact controls then ran with framework retry disabled:

| Control | Result | Duration |
| --- | --- | ---: |
| bounded-output Flash raw PTY, `--retry=0` | 1/1 passed | 18.383s |
| bounded-output Pro raw PTY, `--retry=0` | 1/1 passed | 23.380s |
| Goal-finalization Pro raw PTY, `--retry=0` | 1/1 passed | 17.949s |
| permission recovery Web/ACP/Headless, `--retry=0` | 3/3 passed | 25.946s |

The second complete Production Qualification passed 16/16 and 106/106. It
contained two retry-assisted passes:

- bounded-output DeepSeek V4 Flash raw PTY: `retry x1`;
- bounded-output DeepSeek V4 Pro raw PTY: `retry x1`.

Both exact cells are covered by the independent `--retry=0` controls above.
No Provider-admission target or control cell used framework retry. No retry
was hidden or reported as a zero-retry complete production run.

## Release Boundary

The exact design is
`1def3c69df70c99478b3740112108619ce9d3ce5`. The exact runtime, tests, docs,
and configuration qualified by real API are
`852c8cbab5b115c17ad6d286276d45d2198495ee`. The release metadata commit
`d3e4642347e47cc5c10b1ec0d6ff79922d2dfcbb` changes only package version,
lockfile version, and changelog and was the clean HEAD used for both complete
Production Qualification runs.

The next commit may add only this evidence file. The `v0.10.40` tag must
contain no unqualified runtime, test, configuration, or release metadata
change.
