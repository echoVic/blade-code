# Provider Rate-Limit Cooldown Design

## Context

Blade already owns retry, shared Provider circuit, and four-surface recovery projection. The circuit currently opens only after at least four failures reach an 80% error rate. That policy is appropriate for noisy transport and server failures, but it ignores an explicit first-response `429` with a valid `Retry-After`: another Session in the same Provider failure domain can still issue a request during the server-declared wait.

Codex and Claude Code preserve actionable rate-limit reset information and pause work until recovery. Blade should close this narrower runtime gap without introducing another client-side state machine or Provider-specific account API.

## Decision

A regular circuit attempt that fails with all of the following immediately opens the existing process-wide circuit:

1. classified reason is `rate_limit`;
2. sanitized status is `429`;
3. a finite, positive `retryAfterMs` survives the existing duration bound.

The existing failure-domain key, circuit entry, open/half-open lifecycle, probe lease, generation fencing, registry capacity, and UI projection remain authoritative. The effective open duration is `max(configuredOpenDurationMs, retryAfterMs)`, exactly as for an ordinary threshold-triggered open.

A `429` without an explicit positive retry directive remains a normal failure sample and requires the existing minimum-sample/error-rate threshold. `x-should-retry: false`, billing/quota exhaustion, context overflow, cancellation, and timeout classifications remain non-retryable and do not create this cooldown. Server errors and transport failures retain the four-sample threshold.

## Runtime flow

```text
Session A physical request
  -> 429 + valid Retry-After
  -> classify rate_limit
  -> record one failure sample
  -> Closed -> Open immediately
  -> publish provider.circuit opened/waiting

Session B, same failure domain
  -> circuit preflight
  -> no Provider request
  -> wait or fallback under existing policy

retry boundary reached
  -> one HalfOpen probe lease
  -> success/neutral closes circuit
  -> failure reopens circuit
```

The first Session continues through the existing retry path. It does not sleep twice: retry delay and circuit delay are already combined with `max()`. The foreground recovery deadline remains authoritative and may expire before the Provider retry time.

## Surface behavior

No new public schema is required. Existing projections already carry the necessary bounded data:

- TUI: `Provider 请求受限，Ns 后重试`, with Esc cancellation;
- Web: accessible Provider recovery banner and existing Stop action;
- ACP: `_meta['blade/providerRecovery']`;
- Headless JSONL: `provider_circuit` plus `provider_recovery`.

Web reconnect continues to hydrate `providerRecovery` from the resident Runtime. This patch changes when the shared circuit opens, not the presentation contract.

## Safety and privacy

Only sanitized reason, status, retry duration, reset timestamp, open duration, and sample/failure counts leave the circuit. Provider URL, headers, response body, API key, credential digest, Session ID, and raw error remain private. Retry durations retain the existing production maximum.

Circuit scope remains keyed by provider, wire API, canonical endpoint, model, service tier, API version, credentials, routing headers, and open policy through the existing opaque HMAC. Therefore one tenant/channel cannot suppress an unrelated one.

## Verification

Deterministic tests must prove:

- one `429 + Retry-After` immediately opens the circuit with one sample;
- same-domain preflight blocks before an additional Provider request;
- missing, zero, negative, non-finite, or oversized retry directives cannot create an unbounded cooldown;
- ordinary 429 without a valid directive and all non-rate-limit failures keep the threshold policy;
- after expiry, concurrent callers admit exactly one probe; success closes and failure reopens;
- the existing TUI, Web reload, ACP, and Headless recovery projections remain compatible and leak no private fields.

Production qualification will run DeepSeek Flash and Pro through Headless, real ACP stdio, raw PTY TUI, and production Chromium Web. A local proxy will return one explicit `429 + Retry-After`, hold the single post-cooldown probe, and assert that a second same-domain Session produces zero upstream traffic before the cooldown expires. Web reloads during the wait; PTY observes the countdown directly. Framework and model retries stay at zero except for the Runtime-owned foreground recovery policy under test.

## Non-goals

- Provider-specific subscription/account usage APIs;
- backend-authored marketing or purchase CTAs;
- persistent cooldown state across process restart;
- automatic model selection beyond the existing fallback policy;
- changing retry semantics for 5xx, transport, timeout, or stream-close failures.
