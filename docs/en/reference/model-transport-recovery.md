# Model Transport Recovery

Blade Code centrally owns the retry policy for model requests in `PiAIChatService`. Automatic retries from the pi-ai provider are fixed at `0`, preventing the provider and Agent from each retrying and multiplying request counts, and also preventing the underlying layer from replaying streaming responses without Blade's knowledge.

## Retriable Errors

Blade traverses the `lastError` and `cause` error chain and treats the following errors as transient failures:

- HTTP `408`, `409`, `429`, and `5xx`;
- Network errors such as connection timeout, temporary DNS failure, connection reset or refusal, socket interruption;
- Explicitly gateway-returned `upstream_error` or `temporarily unavailable`;
- Similar status codes and error codes carried in error messages or structured fields.

`maxRetries` represents the maximum number of additional attempts after the initial request. Retries use bounded exponential backoff, respond to the current turn's `AbortSignal` during waiting, and do not start new requests after cancellation.

Real API protocol tests use the same default retry count as production, rather than forcing `maxRetries: 0`. Therefore qualification results simultaneously verify protocol compatibility and production recovery strategy; the replay boundary described below still applies after the first outbound chunk.

Context overflow is a deterministic error. Markers such as `prompt_too_long`, `maximum context length`, and `context_length_exceeded` do not enter transport retries or model fallback even when wrapped by the gateway as HTTP `500`; instead, they return to the Agent loop to trigger reactive compaction.

## Foreground Long Task Recovery

When there is no explicit model `overrides.maxRetries`, the root foreground turn defaults to a maximum of 12 additional requests, and `providerForegroundRecoveryMs` simultaneously limits the total recovery time after the first transient failure:

- Default recovery budget `600000ms` (10 minutes);
- `0` disables extended recovery;
- Other values must be integers between `30000-3600000ms`;
- Explicit `overrides.maxRetries` always takes precedence; `0` still means no retry;
- Primary and fallback share the same recovery starting point and absolute deadline; the default policy also shares the 12 additional attempt cap; explicit `maxRetries` preserves existing per-candidate semantics;
- Extended backoff caps single waits at 60 seconds; long waits produce a `waiting` heartbeat every 15 seconds;
- Both backoff and in-flight retries respond to Esc, ACP cancel, Web stop, Headless signal, and coordinated shutdown.

The recovery clock starts from the first safely replayable transient error and does not include the time taken by the initial normal request. After recovery starts, waiting, connection establishment, and model stream all count against the same budget. When the deadline arrives, the current pi-ai iterator is aborted, hard timers are cleaned up, and a typed `exhausted/recovery_budget` is projected.

Background subagents, verification, compaction, provider health, title generation, and other internal sampling do not inherit the extended budget and continue using their original short retries. This prevents background work from amplifying requests during Provider capacity failures.

New `provider_retry` lifecycle fields:

- `mode`: `standard` or `bounded_foreground`;
- `phase=waiting`;
- `recoveryBudgetMs`, `recoveryElapsedMs`, `recoveryRemainingMs`;
- Terminal state `exhaustedBy=attempt_limit|recovery_budget`.

These fields belong only to runtime surface metadata and do not enter Provider payloads, assistant body text, or durable transcripts. TUI and Web display attempt count and remaining budget within the original status bar; Headless JSONL and ACP use structured fields.

## Provider Request Admission

Blade does not create a process-wide admission scheduler by default. Primary,
retry, fallback, and HalfOpen probe physical streams go directly to the Provider,
with real `429` responses, `retry-after` backoff, and the shared circuit breaker
providing backpressure. Admission is enabled only when the user explicitly sets
`providerRequestConcurrency`, `providerGlobalConcurrency`, or
`providerOwnerConcurrency`.

`providerRequestConcurrency` limits one endpoint/model/tier/credential failure
domain (`1-16`). The global and owner settings respectively limit the process and
one root Session plus all descendants. Unset layers impose no limit, and
foreground, background, and internal requests have no hidden class in-flight
quota. Once admission is enabled, pending counts and retained footprint remain
bounded, with fair scheduling by request class and root owner.

Waiting defaults to 180 seconds, projects a heartbeat every 15 seconds, and
caller abort atomically removes the ticket. `providerRequestAdmissionMs=0` means
fail-fast; other values must be `1000-600000`.
`providerRequestPendingBytes` defaults to 128 MiB and is configurable from
64 KiB-128 MiB. Idle active capacity does not consume the pending byte budget.

The order is fixed as:

```text
circuit preflight
  -> Provider admission
  -> atomic circuit check/probe claim
  -> physical stream
  -> release permit
  -> retry/circuit wait or fallback
```

Known Open circuits do not enter the capacity queue; if the circuit is opened by another Session after queuing, the request performs a second check after obtaining the permit and releases capacity with zero Provider traffic. Permits do not span retry backoff, circuit wait, tool execution, or fallback selection. Queuing does not increment physical attempts; when foreground recovery has started, admission wait shares the remaining budget with the original absolute deadline.

`provider_admission` only projects `queued|admitted|rejected`, request class, `stream|pending_count|pending_bytes` resource, capacity scope, queue/active integers, and bounded wait; request footprint, aggregate pending bytes, failure-domain, root owner, Session ID, endpoint, credentials, and HMAC do not enter surfaces or transcripts.

When retry/fallback ultimately ends with `queue_full`, the turn retains `turn_aborted(cause=failed)` while simultaneously acknowledging only durable input already claimed by that turn. Web reload, SSE reconnect, and ACP load do not bypass the admission boundary to replay the same request; Provider outage, `wait_timeout`, caller cancel, and process crash continue to preserve original input recovery semantics.

## Shared Provider Circuit

Multiple Web/ACP Sessions share the same in-process Provider failure-domain circuit. Identity covers channel, wire API, normalized endpoint, model, service tier, API version, credentials, and routing headers; sensitive values only participate in HMAC-SHA-256 driven by a process random secret and are not projected or persisted.

State machine:

```text
Closed
  -> at least 4 samples in a 60-second window with error rate >= 80%
  -> Open
  -> after open duration only one lease owner
  -> HalfOpen probe
  -> success/neutral Provider response -> Closed
  -> transient failure -> Open
```

Default Open duration is `10000ms`; `providerCircuitBreakerOpenMs=0` disables it, other values must be `1000-300000ms`. A valid `Retry-After` can extend the current Open but cannot extend the foreground recovery deadline. The registry holds a fixed 128 failure domains, each sliding window holds a fixed 256 samples; only idle Closed entries are evicted; no background sweep timer is used. If all 128 entries are Open/HalfOpen, new domains fail-open as no-op circuits, preventing unrelated Providers from being globally rejected.

Each admission returns an opaque token bound to a generation/lease. Normal abort, deadline, and idle timeout explicitly abandon; when the owner disappears, the lease allows unique takeover after at most 5-10 minutes. Results completed by the old owner after takeover are ignored due to token mismatch and cannot close or reopen the new state.

Request semantics:

- Non-final candidates in root foreground directly enter the next fallback when encountering Open;
- The final candidate in root foreground waits within the original `providerForegroundRecoveryMs` deadline, sending a circuit heartbeat every 15 seconds;
- Background, internal, and standard requests do not wait for Open candidates, do not retry the same candidate, but can still enter the next fallback;
- Circuit delay and ordinary retry backoff take the maximum, not the sum;
- The first real Provider chunk records success and preserves the original replay boundary; subsequent stream failures are not written back as zero-output circuit failures.

`provider_circuit` uniformly projects `opened|waiting|probe|closed|reopened|rejected`; fields contain only sanitized reason/status, bounded retry-after, open duration, sample counts, and optional foreground remaining budget. Headless JSONL, TUI, Web SSE/StatusBar, ACP metadata, and subagent SSE use the same protocol; transient state is cleared after completion/reload.

## Total Request Timeout and Stream Liveness Protection

Neither the HTTP SDK's request timeout nor stream liveness timeout alone forms a complete boundary. Some SDKs no longer constrain the response body with request timeout after response headers arrive; on the other hand, as long as the Provider continues sending reasoning or text deltas, the idle watchdog keeps refreshing, and a single physical attempt could still occupy an admission permit indefinitely.

Blade enforces two independent timeouts at the pi-ai adapter boundary:

- `timeout` is the hard total deadline for each physical attempt, defaulting to `180000ms`;
- The total deadline starts only after Provider admission succeeds; queue wait does not consume this budget;
- text, reasoning, tool, usage, finish, or stall recovery cannot refresh the total deadline;
- `overrides.streamIdleTimeout` is the per-semantic-event idle watchdog, defaulting to `300000ms`;
- Neither the first Provider event nor any two events can exceed the idle timeout;
- Both actively abort the current Provider request; normal completion, errors, and cancellation all clean up timers;
- When the Provider closes the stream without sending `done`, it is treated as an incomplete transmission rather than a false success;
- The minimum configurable value for `streamIdleTimeout` is `1000ms`, preventing misconfiguration from causing immediate retry storms.

Retries and fallbacks establish new attempt deadlines each time a new admission permit is obtained. If the shared monotonic foreground recovery budget is earlier or equal to the attempt deadline, the shared budget remains the authoritative abort cause; only when the attempt deadline is strictly earlier does it terminate the request.

The watchdog observes pi-ai semantic events rather than raw socket bytes. Empty keepalives or content-free transport frames do not infinitely extend a request with no model progress.

Within the zero-real-output boundary, total deadline enters bounded retry per standard timeout policy; once text, reasoning, tool, usage, or finish has been delivered, it marks the replay boundary and fails closed. Active idle timeout does not automatically retry within the same turn. Some Provider SDKs cannot guarantee that abort immediately releases the response body after response headers arrive; immediate retries could allow multiple lost-contact requests to overlap. Blade projects this as a standard timeout task failure that can be manually retried. Conversely, EOF where the Provider has explicitly closed without delivering any output can safely enter transport retry.

## Streaming Replay Boundary

Only attempts that have not yet delivered any `StreamChunk` to the Agent loop can be retried. After any of the following events occurs, the request crosses the replay boundary:

- Text or reasoning deltas;
- Complete tool calls;
- usage or finish events.

Errors occurring after crossing the boundary are thrown directly; the current model is not requested from the beginning, nor is a fallback model switched. This limit simultaneously protects terminal output and streaming tool executors: read-only tools may pre-launch before the stream ends, and replaying the same tool call could still produce duplicate network access, duplicate transcript events, or state races.

Only after the primary model exhausts retries in the zero-output state are configured fallback models permitted. Once a fallback produces a chunk, further switching to other models is also prohibited.

## Design Rationale and Verification

This boundary synthesizes Codex's centralized stream retry, Claude Code's foreground bounded recovery, Neovate Code's cancellable exponential backoff, and Grok Build's explicit classification of deterministic and transient errors. Blade additionally incorporates its own streaming tool pre-launch into replay determination, thus using the first outbound chunk as the commit boundary.

Unit tests cover error classification, provider retry ownership, partial text, tool calls, and abort. Production qualification gates also start a local fault-injection proxy for each DeepSeek model: the first real CLI model request returns a single HTTP `503`, subsequent requests are forwarded to the real API; the trajectory must complete code modifications, Bash verification, diff scope checks, and host-side tests.
