# Bounded Foreground Provider Recovery Design

**Date:** 2026-08-16
**Target:** `blade-code@0.10.37`
**Status:** Frozen for implementation

## Problem

Blade owns Provider retry at the `PiAIChatService` boundary and correctly
prevents replay after the first model output. Its default recovery window is
still too short for a production coding task:

```text
initial request
-> at most 2 retries
-> fail the whole Agent turn
```

An upstream deployment, edge outage, rate-limit interval, or transient network
loss that lasts longer than a few seconds therefore terminates a multi-hour
task even though:

- the workspace and durable transcript remain valid;
- no Provider output or tool side effect crossed the replay boundary;
- the user-facing surface is still attached and can cancel;
- retrying the same logical request is safe.

Setting a very large model `maxRetries` is not an acceptable production
contract. It applies to background and internal model calls as well as the
foreground turn, has no logical recovery deadline, and provides no periodic
activity while a long server-directed wait is in progress.

## Reference Evidence

### Claude Code

`src/services/api/withRetry.ts` distinguishes foreground and non-foreground
query sources. Foreground persistent recovery:

- continues transient capacity recovery after the ordinary retry count;
- caps individual waits;
- honors server reset or `Retry-After` guidance;
- chunks long waits and emits periodic API retry activity;
- remains abortable;
- drops non-foreground 529 retries to avoid capacity amplification.

`src/utils/fastMode.ts` also maintains a process-visible cooldown with an
explicit reset timestamp rather than making every request rediscover the same
rate limit.

### Codex

`codex-rs/core/src/responses_retry.rs` treats user sampling connection failure
as a recoverable foreground condition. It:

- increases the reconnect delay up to a fixed 60-second cap;
- publishes retry status to the active front end;
- continues from the same turn;
- keeps ordinary bounded retries and transport fallback for other failures.

`codex-rs/core/src/session/turn.rs` centralizes the replay decision around one
sampling loop, and `max_concurrent_threads_per_session` separately limits
multi-agent amplification.

### Neovate Code

`src/loop.ts` implements cancellable exponential retry and projects retry
attempt, delay, and start time into the UI. It is a useful surface baseline,
but its small retry-turn count is not sufficient for long-running production
work.

### Grok Build

`crates/codegen/xai-grok-sampler/src/retry.rs` uses a minutes-scale total retry
budget, separately caps rate-limit retries, honors bounded `Retry-After`, and
classifies deterministic failures away from transient recovery.

`xai-grok-sampler` gives every request an explicit identity and cancellation
token. `xai-circuit-breaker` additionally demonstrates half-open probe
ownership and abandoned-probe recovery, but a shared circuit breaker is a
separate failure-control layer and is not part of this patch.

## Scope

This patch adds bounded extended recovery only to the root foreground Agent
turn.

Included:

- a root-turn request-origin contract;
- an attempt limit and a monotonic recovery deadline;
- cancellable, heartbeat-producing retry waits;
- one recovery clock shared across primary and fallback models;
- typed Headless, TUI, Web, Server SSE, and ACP projection;
- deterministic race, replay, deadline, and cleanup tests;
- DeepSeek Flash/Pro real-API qualification through all four production
  entrypoints.

Excluded:

- process-wide Provider request admission;
- cross-process rate-limit coordination;
- a shared Provider circuit breaker;
- automatic replay after any Provider output;
- idle-timeout retry while the previous SDK body may still be alive;
- extending background subagent, compaction, health-probe, title-generation,
  or other internal model calls.

Those exclusions preserve independent failure boundaries. Request admission
controls load before an attempt. A circuit breaker coordinates failures across
logical requests. This patch controls the lifetime of one replay-safe
foreground request.

## Frozen Configuration

```ts
export const DEFAULT_FOREGROUND_PROVIDER_RECOVERY_MS = 600_000;
export const MIN_FOREGROUND_PROVIDER_RECOVERY_MS = 30_000;
export const MAX_FOREGROUND_PROVIDER_RECOVERY_MS = 3_600_000;

export const DEFAULT_FOREGROUND_PROVIDER_MAX_RETRIES = 12;
export const PROVIDER_RECOVERY_HEARTBEAT_MS = 15_000;
```

User configuration:

```json
{
  "providerForegroundRecoveryMs": 600000
}
```

Validation:

- `0` disables extended foreground recovery;
- every other value must be an integer from `30000` through `3600000`;
- the value is frozen into the Session runtime configuration snapshot;
- changing global config does not mutate an active turn.

Model override precedence:

```text
overrides.maxRetries is explicit
-> use that exact per-candidate retry count and preserve existing fallback order

overrides.maxRetries is absent
and request is bounded foreground
and providerForegroundRecoveryMs > 0
-> use 12 retries

otherwise
-> use the existing default of 2 retries
```

An explicit `maxRetries: 0` remains a hard no-retry instruction for each model
candidate, but does not disable a configured fallback. The recovery deadline
still caps an explicitly larger retry count across all candidates.

## Request-Origin Contract

`ChatRequestOptions` gains:

```ts
providerRecovery?: {
  mode: 'bounded_foreground';
  budgetMs: number;
};
```

The root `executeLoopGenerator` request attaches this option when:

```text
context.subagentInfo is absent
and providerForegroundRecoveryMs > 0
```

The same options object must flow through streaming and non-streaming fallback.
Subagents and all direct `chat()` callers that omit the option retain standard
retry behavior.

The request option is runtime control metadata. It is never serialized into
the Provider payload, transcript, Session JSONL, or model-visible messages.

## Recovery State Machine

```text
Initial
  -> request succeeds
     -> Completed
  -> deterministic/non-retryable failure
     -> Failed
  -> caller abort
     -> Aborted
  -> retryable failure before output
     -> Recovering

Recovering
  -> scheduled
  -> zero or more waiting heartbeats
  -> attempt
  -> request succeeds
     -> Recovered -> Completed
  -> retryable failure before output
     -> Recovering
  -> attempt limit reached
     -> Exhausted(attempt_limit) -> Failed
  -> recovery deadline reached
     -> Exhausted(recovery_budget) -> Failed
  -> caller abort
     -> Aborted
  -> any output crosses replay boundary
     -> no replay -> Failed
```

The recovery clock starts when the first replay-safe transient failure is
classified. Time spent on the initial request does not consume recovery
budget. After recovery starts, the budget includes:

- retry backoff;
- server-directed wait;
- Provider connection establishment;
- time to first and subsequent semantic stream events.

The attempt limit and deadline are independent. Whichever is reached first
terminates recovery.

## Hard Deadline

Every physical Provider attempt after recovery starts receives a child
`AbortSignal` whose deadline is the remaining logical recovery budget.

Deadline expiry must:

1. abort the current pi-ai request;
2. close the async iterator;
3. emit one typed `exhausted/recovery_budget` event when no output crossed the
   replay boundary;
4. throw a stable `ProviderRecoveryBudgetExceededError`;
5. clear timers and listeners before the logical request settles.

Caller abort remains distinguishable from budget exhaustion and wins without
an `exhausted` event.

A budget expiry after any content, reasoning, tool call, usage, or finish
event must not synthesize a retryable zero-output failure.

## Backoff and Heartbeats

Standard retries keep the existing backoff.

Bounded foreground recovery may increase exponential delay up to 60 seconds:

```text
500ms, 1s, 2s, 4s, 8s, 16s, 32s, 60s, 60s, ...
```

Server `Retry-After` and `Retry-After-Ms` remain authoritative but are clamped
to 60 seconds and to the remaining recovery budget.

Long waits are split into at most 15-second cancellable chunks. Every completed
chunk before the final attempt emits a `waiting` heartbeat. No timer, sleep, or
heartbeat survives request completion, abort, fallback success, or Session
shutdown.

Performance tests use injected time and assert state transitions. They must not
depend on wall-clock duration.

## Fallback Ownership

Primary and configured fallback models share:

- the original replay boundary;
- one recovery start timestamp;
- one absolute deadline;
- one logical retry attempt count when using the default foreground policy.

An explicit model `maxRetries` preserves the existing per-candidate count while
all candidates still share the absolute deadline. This keeps user override and
fallback behavior backward compatible without allowing a fallback to reset the
time budget.

Switching models cannot reset the recovery budget or allow more than the
logical maximum number of physical retries.

Existing fallback order remains:

```text
primary standard attempts
-> fallback models in configured order
-> remaining bounded foreground recovery on the last eligible candidate
```

If a candidate emits any real chunk, no later candidate or recovery attempt may
start.

## Retry Events

`ProviderRetryPhase` becomes:

```ts
type ProviderRetryPhase =
  | 'scheduled'
  | 'waiting'
  | 'attempt'
  | 'recovered'
  | 'exhausted';
```

Events gain:

```ts
mode: 'standard' | 'bounded_foreground';
recoveryBudgetMs?: number;
recoveryElapsedMs?: number;
recoveryRemainingMs?: number;
exhaustedBy?: 'attempt_limit' | 'recovery_budget';
```

Rules:

- standard retries identify `mode: 'standard'`;
- bounded foreground retries identify `mode: 'bounded_foreground'`;
- recovery fields are present only for bounded foreground mode;
- time values are non-negative integers and are clamped to the configured
  budget;
- `waiting` carries the latest elapsed and remaining values;
- `exhaustedBy` is present only on `exhausted`;
- Provider body, headers, URL, model response, credential, and raw error are
  forbidden.

## Surface Projection

### Headless JSONL

`provider_retry` adds:

```json
{
  "mode": "bounded_foreground",
  "recovery_budget_ms": 600000,
  "recovery_elapsed_ms": 15000,
  "recovery_remaining_ms": 585000,
  "exhausted_by": "recovery_budget"
}
```

The TypeBox schema rejects unknown enum values and invalid time ranges.

### TUI

`LoadingIndicator` renders:

```text
Provider 暂时不可用，正在有界恢复 (4/12)，剩余约 8m 15s · Esc 取消
```

`waiting` keeps the same stable layout and updates remaining time without
creating transcript messages.

### Web

The production StatusBar renders the bounded recovery mode, attempt count, and
remaining budget. It is an inline status, not a modal or card.

SSE transmits the typed event. Reload after completion shows only durable
conversation results; retry status is ephemeral and must not reappear.

### ACP

`session_info_update` extends `blade/providerRetry` with the same camelCase
fields. It must not emit retry text as assistant content.

## Failure Semantics

The following never enter extended recovery:

- caller abort;
- Provider stream idle watchdog expiry;
- context limit or request-too-large errors;
- authentication, billing, quota, or deterministic 4xx errors;
- malformed local model configuration;
- any error after the replay boundary;
- internal requests without bounded foreground ownership.

`429`, `408`, `409`, `5xx`, explicit retryable Provider metadata, transport
failure, and clean pre-output stream closure remain eligible.

## Deterministic Test Matrix

### Service State Machine

- four transient failures then success exceeds the old default and recovers;
- explicit `maxRetries: 0` performs one request;
- explicit retry count is respected and still capped by the time budget;
- attempt-limit exhaustion emits exactly one terminal event;
- budget expiry during backoff aborts without another request;
- budget expiry during an in-flight retry aborts its iterator;
- caller abort during backoff and in-flight retry emits no false exhaustion;
- partial text, reasoning, tool call, usage, and finish each block replay;
- fallback shares the original deadline and logical count;
- fallback success cancels every recovery timer;
- heartbeat count and metadata are exact under a fake clock;
- concurrent service instances do not share timers or replay state.

### Runtime Origin

- root turn attaches bounded foreground options;
- foreground required-tool and non-streaming fallback preserve the options;
- foreground command handoff follow-up turns remain eligible;
- foreground Goal continuation remains eligible;
- subagent, verification, compaction, provider health, title generation, and
  direct internal sampling remain standard;
- runtime config is immutable for the active Session.

### Surfaces

- Headless schema and projector;
- TUI store and stable loading layout;
- Web SSE handler, StatusBar, completion clear, and reload clear;
- ACP metadata and no assistant-content pollution;
- Server sanitizer rejects malicious or oversized fields.

### Search Gates

- no pi-ai automatic retry;
- no `Infinity` retry count or deadline;
- no test-only production bypass;
- no retry after the replay boundary;
- no recovery metadata in Provider payload or transcript persistence;
- all timers are cleared or unref'd.

## Real-API Qualification

Add a release-blocking matrix:

```text
DeepSeek V4 Flash x Headless / ACP / raw PTY / production Web
DeepSeek V4 Pro   x Headless / ACP / raw PTY / production Web
```

A transparent local proxy must:

1. accept the real production Provider request;
2. return four replay-safe transient failures before forwarding;
3. include a bounded wait long enough for each surface to render recovery;
4. forward the fifth request unchanged to the real Provider;
5. record request count, timing, headers, and disconnects without retaining the
   credential.

The user task must modify a fixture exactly once, run a real verification
command, inspect the diff, and return a host nonce.

Every cell proves:

- the old two-retry policy would have failed;
- the fifth request reaches the real Provider in the same logical turn;
- scheduled, attempt, waiting where applicable, and recovered events are
  ordered and sanitized;
- one final assistant result and one tool side effect are durable;
- no overlapping retry request exists;
- caller/session identity is unchanged;
- TUI exposes Esc cancellation;
- Web uses the production build and pinned Chromium, shows live recovery, then
  completes without refresh and remains correct after reload;
- ACP emits metadata only;
- Provider key is absent from command lines, logs, events, JSONL, DOM, ACP, and
  retained artifacts;
- proxy, sockets, browser, pages, SSE readers, PTY, ACP process, temporary HOME,
  Session roots, and ports are reclaimed.

The matrix must run with framework retry disabled for feature evidence.

## Release Gate

Before tagging:

1. focused deterministic tests pass;
2. the eight-cell real-API matrix passes with zero framework retry;
3. existing Provider retry, stall, reactive compaction, bounded output,
   foreground handoff, graceful shutdown, Goal, TUI, Web, and ACP trajectories
   remain green;
4. `bun run qualify:production` passes all gates;
5. evidence is written to
   `docs/testing/bounded-foreground-provider-recovery-evidence.md`;
6. package and lockfile are `0.10.37`;
7. npm fresh install reports `0.10.37`;
8. feature worktree, branch, proxy, profiles, and temporary roots are removed.
