# Bounded Shared Provider Circuit Breaker Design

**Date:** 2026-08-16
**Target:** `blade-code@0.10.38`
**Status:** Frozen for implementation

## Problem

`blade-code@0.10.37` can keep one replay-safe root foreground request alive
through a bounded Provider outage. That solves the lifetime of one logical
request, but every `PiAIChatService` instance still discovers the same outage
independently.

In a Web or ACP process with multiple Sessions, an outage can therefore
produce this traffic shape:

```text
Session A -> initial request + up to 12 foreground retries
Session B -> initial request + up to 12 foreground retries
Session C -> initial request + up to 12 foreground retries
background/internal requests -> their own short retries
```

The existing per-request jitter reduces synchronization but does not create
shared knowledge. During a Provider deployment, capacity cascade, rate-limit
window, or edge outage:

- new Sessions continue sending requests to a known-unhealthy failure domain;
- background and internal requests consume capacity that should be reserved
  for user-blocking work;
- every foreground turn pays the same failed discovery cost;
- recovery can create a thundering herd when independent timers expire;
- no request owns the right to test whether the Provider recovered;
- an aborted recovery probe has no shared replacement contract.

A process-wide concurrency limit is related but does not solve this problem.
Admission bounds simultaneous attempts while a circuit breaker decides whether
an attempt should exist at all based on recent shared outcomes.

## Reference Evidence

### Claude Code

`src/services/api/withRetry.ts` prevents non-foreground 529 amplification and
tracks repeated 529 failures before fallback. `src/utils/fastMode.ts` keeps a
process-visible cooldown with:

- an explicit reset timestamp;
- a reason (`rate_limit` or `overloaded`);
- subscribers for cooldown start and expiry;
- immediate reuse by later requests instead of rediscovering the same
  rate-limit state.

Claude Code does not expose a general Provider half-open state machine. Its
fast-mode cooldown still proves that process-visible Provider state is useful
and should be separate from one request's retry counter.

### Codex

`codex-rs/core/src/responses_retry.rs` keeps retry state inside one sampling
loop and publishes reconnect status to the active frontend. The surrounding
runtime separately bounds concurrent threads per Session.

Codex does not currently coordinate general sampling failures across Sessions.
It is the control showing that robust per-request recovery alone still leaves
the cross-request outage domain uncoordinated.

### Neovate Code

`src/loop.ts` owns cancellable exponential backoff and UI retry projection per
loop. It has no shared Provider outage state. This is another control: adding
more per-request retries or countdown UI does not prevent multiple loops from
hammering the same unhealthy endpoint.

### Grok Build

`crates/common/xai-circuit-breaker` provides the strongest reference:

- `Closed -> Open -> HalfOpen -> Closed/Open`;
- a bounded sliding window with minimum samples and an error-rate threshold;
- one half-open probe by default;
- compare-and-swap ownership at the open-duration boundary;
- a lease that reclaims an abandoned probe;
- typed retry-after for rejected requests;
- bounded sample retention;
- per-key registry isolation.

Its tests explicitly cover concurrent probe claims, CAS losers, repeatedly
abandoned probes, stale windows, and bounded memory.

Blade adopts those invariants but changes two details for JavaScript runtime
ownership:

1. every admitted attempt receives an epoch-scoped token, so a stale result
   after probe takeover cannot close or reopen a newer generation;
2. normal cancellation runs an explicit `abandon()` path, so another waiter
   can probe immediately instead of waiting only for lease expiry.

## Scope

Included:

- a process-wide, per-failure-domain Provider circuit registry;
- bounded sliding-window state;
- one epoch/lease-owned half-open probe;
- abandoned-probe recovery and stale-result rejection;
- root foreground waiting inside the existing recovery deadline;
- fail-fast standard/background/internal behavior;
- fallback to a distinct candidate when one candidate circuit is open;
- typed Headless, TUI, Web, Server SSE, and ACP projection;
- deterministic concurrency, time, fallback, replay, and cleanup tests;
- real DeepSeek qualification through all four production entrypoints;
- shared same-domain controls for the multi-Session Web and ACP runtimes.

Excluded:

- cross-process or distributed circuit state;
- a general Provider request concurrency scheduler;
- persistence of circuit state across process restart;
- retries after any Provider replay boundary;
- changing the 0.10.37 foreground attempt or time budgets;
- treating authentication, billing, context, quota, caller abort, or local
  configuration errors as Provider outage samples;
- exposing failure-domain keys, endpoint URLs, headers, or credential
  fingerprints to any user-facing surface.

Cross-process coordination would require a durable lock or external store and
has different failure semantics. It remains a separate feature.

## Frozen Bounds

```ts
export const DEFAULT_PROVIDER_CIRCUIT_OPEN_MS = 10_000;
export const MIN_PROVIDER_CIRCUIT_OPEN_MS = 1_000;
export const MAX_PROVIDER_CIRCUIT_OPEN_MS = 300_000;

export const PROVIDER_CIRCUIT_WINDOW_MS = 60_000;
export const PROVIDER_CIRCUIT_MIN_SAMPLES = 4;
export const PROVIDER_CIRCUIT_ERROR_RATE_THRESHOLD = 0.8;
export const PROVIDER_CIRCUIT_HALF_OPEN_MAX_PROBES = 1;

export const MIN_PROVIDER_CIRCUIT_PROBE_LEASE_MS = 300_000;
export const MAX_PROVIDER_CIRCUIT_PROBE_LEASE_MS = 600_000;
export const PROVIDER_CIRCUIT_HEARTBEAT_MS = 15_000;

export const MAX_PROVIDER_CIRCUIT_REGISTRY_ENTRIES = 128;
export const MAX_PROVIDER_CIRCUIT_WINDOW_ENTRIES = 256;
export const PROVIDER_CIRCUIT_IDLE_TTL_MS = 1_800_000;
```

User configuration:

```json
{
  "providerCircuitBreakerOpenMs": 10000
}
```

Validation:

- `0` disables the Provider circuit breaker;
- any other value must be a safe integer from `1000` through `300000`;
- only the open duration is configurable;
- sample threshold, error-rate threshold, window size, probe count, lease
  bounds, and registry bounds remain production invariants;
- the value is frozen into a Session runtime snapshot;
- active Sessions do not observe later global config changes.

Tests may configure a shorter valid open duration. Production evidence must
state the test duration and the 10-second default.

## Failure-Domain Identity

Circuit state is shared only when two physical requests have the same
canonical failure-domain key.

The key includes:

```text
Provider channel id
wire API
canonical base URL
model id
service tier
API version / deployment identity where applicable
explicit credential scope
custom routing-header scope
configured open duration
```

Credential and header values must never appear directly in the key. The
process creates a random secret at startup and uses HMAC-SHA-256 to derive
opaque, process-local scope digests:

```text
HMAC(process_secret, explicit_api_key)
HMAC(process_secret, canonical_sorted_custom_headers)
```

Properties:

- equal values in one process produce the same scope;
- a dictionary attacker cannot validate guesses without the random process
  secret;
- digests are never logged, serialized, projected, or persisted;
- a restart creates unrelated digests and intentionally forgets circuit
  state;
- catalog-managed credentials use the Provider channel id as their credential
  scope because the credential store is already keyed by that id;
- primary and fallback candidates compute their keys independently from the
  actual candidate model.

Including model and service tier avoids letting a model-specific 429 or fast
tier outage suppress a healthy standard route. Including the endpoint and
channel prevents project-local custom gateways from contaminating each other.
Including the open-duration policy prevents two immutable Session snapshots
from silently sharing different state-machine timing.

The key is an internal implementation detail. Circuit events contain no key,
model id, Provider id, endpoint, header, or digest.

## Bounded Registry

The process owns one lazy `ProviderCircuitRegistry`.

Each entry contains:

- the breaker state;
- at most 256 sliding-window samples;
- last transition and touch timestamps;
- the last sanitized retry reason/status;
- current generation;
- optional probe lease identity and expiry.

Registry rules:

1. lookup first evicts closed entries idle for 30 minutes;
2. if capacity remains, the requested key is created;
3. at capacity, the least-recently-used closed entry is evicted;
4. open and half-open entries are never evicted to admit another key;
5. if all 128 entries are active, a new key receives a no-op circuit handle.

The final rule deliberately degrades circuit protection instead of denying a
healthy, unrelated Provider. Memory remains bounded and existing unhealthy
domains remain protected. A diagnostic counter may record this condition, but
no secret-bearing key is logged.

The registry has no interval timer. Eviction is lookup-driven, so shutdown
does not own a sweep timer.

## State Machine

```text
Closed
  -> admitted regular attempt
  -> neutral outcome: no sample
  -> success: append success sample
  -> circuit failure: append failure sample
  -> sample_count >= 4 and error_rate >= 0.8
       -> Open(generation + 1)

Open
  -> before nextProbeAt: reject with retryAfterMs
  -> at/after nextProbeAt:
       exactly one caller claims probe lease
       -> HalfOpen

HalfOpen
  -> same live probe owner checks/records
  -> other callers reject with bounded probe retryAfterMs
  -> probe success or neutral Provider response
       -> Closed(generation + 1, clear window)
  -> probe circuit failure
       -> Open(generation + 1, new nextProbeAt)
  -> owner abandon
       -> HalfOpen with no owner; next caller may claim immediately
  -> owner disappears without abandon and lease expires
       -> exactly one caller takes over with a new lease id
  -> stale prior owner records after takeover
       -> ignored
```

State mutation is synchronous. JavaScript's run-to-completion semantics make
the check-and-claim operation atomic inside one process without an async gap.

Every admission returns an opaque attempt token:

```ts
interface ProviderCircuitAttemptToken {
  readonly entry: object;
  readonly generation: number;
  readonly attemptId: number;
  readonly kind: 'regular' | 'probe' | 'noop';
  readonly probeLeaseId?: number;
}
```

Callers cannot construct a valid token. `record()` and `abandon()` accept only
the exact entry and current generation/lease identity.

## Effective Open Duration

The normal open duration is `providerCircuitBreakerOpenMs`.

When a counted failure carries valid `Retry-After` or `Retry-After-Ms`, the
current open interval becomes:

```text
max(configured open duration, bounded server delay)
```

The server delay is parsed by the existing Provider metadata path and clamped
to `MAX_PROVIDER_CIRCUIT_OPEN_MS`. It never extends a foreground recovery
deadline. A 10-minute foreground budget encountering a five-minute circuit
can wait at most its own remaining budget.

Repeated stale failures from attempts admitted before the trip do not move
`nextProbeAt`. Only the current half-open probe may reopen and establish a new
interval.

## Probe Lease

The service computes the lease from its stream idle timeout:

```text
clamp(
  effective stream idle timeout,
  MIN_PROVIDER_CIRCUIT_PROBE_LEASE_MS,
  MAX_PROVIDER_CIRCUIT_PROBE_LEASE_MS
)
```

The default is therefore 300 seconds, matching Blade's Provider stream idle
watchdog. A foreground recovery deadline may abort earlier.

Normal completion paths always call one of:

- `recordSuccess(token)`;
- `recordFailure(token, details)`;
- `recordNeutral(token)`;
- `abandon(token)`.

The lease is a crash/bug backstop, not the normal cancellation path.

## Counted Outcomes

One physical attempt contributes at most one sample.

Counted circuit failures:

- retryable `429`;
- retryable `5xx`, including `529`;
- retryable transport failure before Provider output;
- retryable stream closure before Provider output.

Neutral outcomes:

- context/request-size failure;
- authentication, billing, quota, and deterministic 4xx failure;
- malformed local configuration;
- fallback/model lookup failure;
- any Provider response that is not classified as a circuit failure.

Abandoned outcomes:

- caller abort;
- foreground recovery budget expiry;
- stream idle watchdog expiry;
- a local exception before any Provider response.

Abandonment contributes no sample. A half-open abandonment releases the probe
without closing or reopening the circuit.

Success:

- the first real Provider chunk of text, reasoning, tool call, usage, or
  finish;
- a stream that completes successfully without a semantic chunk.

After the first real chunk, the attempt has already recorded success. A later
stream failure does not become a zero-output circuit failure and does not
change replay behavior.

A neutral Provider response from the current half-open probe closes the
breaker. It proves that the endpoint is reachable and no longer returning the
outage class that opened the circuit, even though the logical request may
still fail for a request-specific reason.

## Request-Origin Behavior

### Bounded Root Foreground

When `ChatRequestOptions.providerRecovery.mode === 'bounded_foreground'`:

- encountering an open circuit on a non-terminal primary/fallback candidate
  skips that candidate and advances through the existing fallback order;
- encountering an open circuit on the terminal candidate starts the existing
  recovery clock if it has not started;
- circuit wait, retry backoff, connection time, and stream time share the same
  absolute recovery deadline;
- waiting is split into cancellable chunks of at most 15 seconds;
- each chunk produces a typed heartbeat;
- when the deadline wins, the existing
  `ProviderRecoveryBudgetExceededError` and `provider_retry/exhausted` contract
  remain authoritative;
- caller abort, Esc, Web stop, ACP cancel, and shutdown interrupt the wait
  immediately;
- exactly one waiter may become the half-open probe.

Circuit delay and per-request retry backoff do not add together:

```text
effective wait = max(retry backoff, circuit retryAfter)
```

The wait is then clamped to the foreground recovery deadline.

### Standard, Background, and Internal Requests

Requests without bounded foreground ownership do not wait on an open circuit.
They:

1. emit a typed `rejected` circuit event to their owning surface when one
   exists;
2. throw `ProviderCircuitOpenError`;
3. perform no request to that candidate;
4. remain eligible for the next configured fallback candidate;
5. never locally retry the same open candidate.

This keeps compaction, verification, health probes, title generation,
background subagents, and internal sampling from amplifying a known outage.

`providerCircuitBreakerOpenMs=0` preserves the pre-0.10.38 request behavior.

## Fallback Behavior

Circuit state is candidate-specific.

```text
primary circuit open
  -> bounded foreground skips primary when a fallback remains
  -> bounded foreground waits only when primary is the terminal candidate
  -> standard request skips primary and may try fallback

primary fails and opens
  -> existing replay-safe fallback rules still apply

fallback has a different failure-domain key
  -> its own circuit is consulted independently

fallback circuit also open
  -> standard request continues to the next fallback
  -> bounded foreground continues while another fallback remains
  -> bounded foreground waits only on the terminal fallback
```

`ProviderCircuitOpenError` is fallback-eligible but not same-candidate
retryable. This distinction must not be encoded by string matching.

Primary/fallback still share the original 0.10.37 replay boundary and
foreground recovery deadline.

## Circuit Events

```ts
export type ProviderCircuitPhase =
  | 'opened'
  | 'waiting'
  | 'probe'
  | 'closed'
  | 'reopened'
  | 'rejected';

export interface ProviderCircuitEvent {
  phase: ProviderCircuitPhase;
  reason: ProviderRetryReason;
  statusCode?: number;
  retryAfterMs?: number;
  nextProbeAt?: number;
  openDurationMs: number;
  sampleCount?: number;
  failureCount?: number;
  recoveryRemainingMs?: number;
}
```

Rules:

- counts are bounded non-negative integers;
- `nextProbeAt` is a wall-clock UI hint, not persisted ownership;
- `retryAfterMs` is recomputed and non-negative;
- `recoveryRemainingMs` appears only for bounded foreground waiting;
- `probe` contains no lease id or internal generation;
- events never contain the failure-domain key, endpoint, Provider/model id,
  headers, response body, raw error, credential, or digest;
- `closed` clears ephemeral UI state;
- turn completion/error/cancellation also clears ephemeral UI state.

The event is separate from `provider_retry`. Retry describes one logical
request's attempts; circuit describes shared cross-request health.

## Surface Projection

### Headless JSONL

```json
{
  "event_version": 1,
  "type": "provider_circuit",
  "phase": "waiting",
  "reason": "server_error",
  "status_code": 503,
  "retry_after_ms": 1800,
  "next_probe_at": 1786840000000,
  "open_duration_ms": 2000,
  "recovery_remaining_ms": 593000
}
```

TypeBox rejects unknown phases, negative values, non-integer counts, and
oversized/unrecognized fields.

### TUI

`LoadingIndicator` gives circuit state priority over ordinary retry state:

```text
Provider 故障已隔离，等待恢复探测 (2s)，剩余预算 9m 53s · Esc 取消
Provider 正在执行唯一恢复探测 · Esc 取消
```

The layout remains stable and no text enters the transcript.

### Web

The inline StatusBar renders:

```text
Provider · Circuit open · probe in 2s · 9m 53s
Provider · Recovery probe
```

It remains an inline operational state, not a modal or nested card. Completion
and reload clear it.

### ACP

`session_info_update` emits:

```ts
'blade/providerCircuit': {
  phase,
  reason,
  statusCode,
  retryAfterMs,
  nextProbeAt,
  openDurationMs,
  sampleCount,
  failureCount,
  recoveryRemainingMs,
}
```

No circuit text is emitted as assistant content.

### Server SSE

Root and subagent LoopEvents use the same sanitized fields. Unknown fields
from an untrusted event object are dropped before SSE publication.

## Deterministic Test Matrix

### State Machine

- four failures trip at the frozen threshold;
- three failures plus one success do not trip;
- four failures plus one success trip at exactly 80%;
- samples older than 60 seconds are evicted;
- sample retention never exceeds 256;
- disabled mode records nothing and always admits;
- open reports exact monotonic retry-after;
- open transitions to half-open only after the effective interval;
- exactly one concurrent caller claims the probe;
- probe success closes and clears the window;
- probe circuit failure reopens with a new interval;
- probe neutral outcome closes;
- explicit abandon immediately releases ownership;
- expired abandoned lease admits exactly one takeover;
- stale original probe success/failure after takeover is ignored;
- stale regular failures cannot extend a newer open interval;
- repeated abandonment always leaves a recovery path.

### Registry and Identity

- same failure-domain input returns shared state;
- different endpoint, model, tier, API version, credential, header route, or
  open policy remains isolated;
- raw key/header/credential values are absent from generated keys and events;
- equal secret inputs share only inside one process-secret scope;
- idle closed entries are evicted;
- least-recently-used closed entry is evicted at capacity;
- open/half-open entries are retained;
- all-active overflow returns a no-op handle without growing past 128.

### PiAIChatService

- every physical attempt checks the circuit before pi-ai;
- one attempt records at most one outcome;
- four replay-safe failures open the circuit;
- bounded foreground waits, probes, and recovers inside its original deadline;
- circuit and retry delays use `max`, not sum;
- circuit wait expiry produces one recovery-budget exhaustion;
- caller abort during open wait is immediate and produces no false probe;
- caller abort while probing abandons ownership;
- standard/internal request sends zero traffic while open;
- standard/internal open primary remains fallback-eligible;
- open fallback does not retry itself and advances to the next candidate;
- first real chunk closes a probe before yielding content;
- text/reasoning/tool/usage/finish replay boundaries remain unchanged;
- a post-output failure does not record a circuit failure;
- deterministic/non-circuit errors are neutral;
- primary/fallback use distinct keys;
- timers/listeners return to zero.

### Runtime Origin and Configuration

- root turn receives bounded wait behavior;
- subagent, verification, compaction, health, and internal callers fail fast;
- Session runtime snapshots the open duration;
- `0` disables the feature;
- startup and settings validation reject unsafe values;
- global config persistence routes only the documented field.

### Surfaces

- Headless schema and projector;
- TUI store and stable LoadingIndicator layout;
- Web SSE handler, StatusBar, completion clear, and reload clear;
- ACP metadata and no assistant-content pollution;
- Server sanitizer strips malicious or oversized fields.

### Search Gates

- no failure-domain key or digest reaches a surface/transcript;
- no unbounded registry/window;
- no interval sweep timer;
- no test-only production bypass;
- no retry after Provider output;
- no standard request sleeps on an open circuit;
- no stale token can mutate a new generation.

## Real-API Qualification

### Four-Surface Matrix

Extend the existing DeepSeek Flash/Pro matrix:

```text
DeepSeek V4 Flash x Headless / ACP / raw PTY / production Web
DeepSeek V4 Pro   x Headless / ACP / raw PTY / production Web
```

For this qualification, the valid test configuration uses a 2,000ms open
duration. The production default remains 10,000ms.

The transparent proxy:

1. returns four replay-safe `503` responses;
2. proves the fourth failure opens the circuit;
3. receives no request during the open interval;
4. forwards only the half-open probe to the real Provider;
5. records request timing without retaining credentials.

Each cell retains the 0.10.37 coding-task proof:

- inspect fixture files;
- perform exactly one Edit;
- run exactly one Bash;
- pass the host verifier;
- produce exactly one final marker and terminal turn;
- leave only the intended source diff.

Each cell additionally proves:

- ordered `opened -> waiting/probe -> closed` projection;
- no fifth request before the open interval;
- one half-open probe;
- foreground recovery budget includes circuit waiting;
- Headless/TUI/Web/ACP render the typed state;
- no circuit state survives completion or reload;
- no credential, endpoint, key, digest, or private error body leaks;
- proxy, sockets, processes, terminals, PTY, browser/pages, SSE, ports,
  temporary HOME/storage/workspace, and config are reclaimed.

Framework retry is disabled.

### Multi-Session Shared Controls

Run:

```text
DeepSeek V4 Flash/Pro x production Web two-Session control
DeepSeek V4 Flash/Pro x ACP two-Session control
```

Session A trips the shared circuit. Session B starts while it is open.

Required proof:

- Session B sends zero Provider traffic before admission;
- both Sessions observe the same sanitized open interval;
- exactly one Session owns the first half-open probe;
- probe success closes the shared circuit;
- the other Session proceeds after close;
- both Sessions receive independent real Provider results;
- no Session identity, transcript, cancellation, or surface event crosses
  ownership boundaries;
- all multi-Session resources are reclaimed.

Headless and TUI do not host concurrent Sessions in one process. Their
single-Session matrix validates projection and probe behavior; Web and ACP
provide the non-sampled shared-state proof for every production runtime that
actually multiplexes Sessions.

## Failure Modes

### False-positive trip

Mitigation:

- four samples and an 80% threshold;
- only retryable outage classes count;
- request-specific failures are neutral;
- model/tier/credential/header routing is isolated;
- a neutral half-open response closes the circuit;
- users can disable with `providerCircuitBreakerOpenMs=0`.

### Circuit wait extends foreground recovery

Forbidden. All waits are clamped to the existing absolute recovery deadline.
No circuit timer or fallback may reset it.

### Probe owner is cancelled

`finally` abandons the lease synchronously. The next waiter may claim
immediately. Lease expiry remains a backstop.

### Stale probe completes after takeover

Generation and lease identity mismatch; the result is ignored.

### Registry reaches capacity

Closed LRU entries are evicted first. If all entries are active, the new
failure domain receives a no-op handle. Memory remains bounded without
cross-domain denial.

### Provider returns output then disconnects

The first real chunk records circuit success and crosses the replay boundary.
The later error is surfaced without retry and does not reopen the circuit.

### Different fallback is healthy

The fallback has a different key and remains eligible. An open primary is not
treated as a same-candidate retryable error.

## Release Gate

Before tagging:

1. focused state-machine, service, runtime, and surface tests pass;
2. the eight-cell real-API matrix passes with zero framework retry;
3. all four Web/ACP shared controls pass with zero framework retry;
4. existing retry, stall, compaction, bounded output, handoff, shutdown, Goal,
   subagent, TUI, Web, and ACP controls remain green;
5. `bun run qualify:production` passes all checks;
6. evidence is written to
   `docs/testing/bounded-shared-provider-circuit-breaker-evidence.md`;
7. package, lockfile, and built CLI are `0.10.38`;
8. npm fresh install reports `0.10.38`;
9. feature worktree, branch, proxies, browser, PTY, profiles, processes, and
   temporary roots are removed.
