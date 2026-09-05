# Provider Recovery Surface Design

## Context

Blade already has bounded Provider recovery in `PiAIChatService`: physical request
admission, retry with `Retry-After`, a process-shared circuit breaker, stream-stall
warnings, and ordered fallback candidates. The Agent loop projects the corresponding
typed events to TUI, Web, ACP, and headless consumers.

The recovery state is nevertheless owned by each consumer today. TUI and Web keep
separate transient admission, retry, circuit, and stall fields; Web loses them when
its Session SSE connection reloads; ACP and headless expose only selected event
fragments; and `model_fallback` carries no source model, target model, or bounded
reason. A user can therefore know that a turn is still running without reliably
knowing what Blade is waiting for, how long it may wait, or which model it selected.

Recent reference implementations point to the same product requirement through
different mechanisms. Codex uses bounded, allowlisted actionable rate-limit banners
and fences stale refreshes. Claude Code keeps recovery feedback attached to the
active turn. Neovate treats empty and interrupted streams as explicit runtime states.
grok-build includes remaining retry delay in its circuit state. Blade should adopt
the common runtime ownership and stale-update protections without importing
provider-specific account, billing, or purchase actions.

## Goals

1. Make `SessionRuntime` the authority for the active turn's Provider recovery
   state.
2. Give TUI and Web a consistent, actionable explanation of admission waits,
   retries, open circuits, stream stalls, and model fallback.
3. Restore the authoritative state immediately after Web SSE reconnect and expose
   it to ACP and headless consumers.
4. Fence late events from an older run so they cannot overwrite a newer run.
5. Keep the projection bounded, typed, ephemeral, and free of credentials or raw
   Provider-controlled text.
6. Preserve the existing cancellation and request-replay boundaries.
7. Qualify the feature through deterministic tests, production Web GUI and raw PTY
   journeys, real ACP stdio, and real DeepSeek integration trajectories.

## Non-Goals

- Persisting recovery state in a transcript, Session metadata, config, or a client
  ledger.
- Resuming an interrupted Provider stream after a process restart.
- Adding a durable server event log for recovery updates.
- Allowing a user to switch fallback candidates or replay a request in the middle
  of a stream.
- Adding provider account, quota-purchase, subscription, or arbitrary URL actions.
- Rendering raw response bodies, headers, base URLs, API keys, or Provider error
  messages.
- Replacing the existing terminal task retry, edit-and-resend, model-settings, or
  cancel APIs.

## Chosen Approach

Use one runtime-owned, Session-scoped, in-memory projection. `Agent.chatStream()`
starts a recovery generation, passes each relevant loop event through a pure reducer,
and clears the generation in its terminal `finally` path. The reducer emits a
versioned projection that every surface can render. Existing fine-grained Provider
events remain available for protocol compatibility, but they stop being UI sources
of truth.

This is preferred over consumer-owned aggregation because only the runtime can reject
late events before they reach every surface, and only an authoritative runtime
snapshot can repair a reconnecting Web client. Persisting the projection was rejected:
after the owning process or stream is gone, a stored "retrying" state would be false
and potentially permanent.

## Public Projection Contract

Add a TypeBox contract under `src/api/providerRecoverySchemas.ts`. The wire object is
an envelope rather than a bare snapshot so a clear operation is observable:

~~~ts
interface ProviderRecoveryProjectionV1 {
  version: 1;
  generation: string;
  revision: number;
  snapshot: ProviderRecoverySnapshotV1 | null;
}

interface ProviderRecoverySnapshotV1 {
  activity:
    | 'admission_wait'
    | 'retry_wait'
    | 'retry_attempt'
    | 'circuit_open'
    | 'circuit_probe'
    | 'stream_stall'
    | 'fallback';
  reason:
    | 'capacity'
    | 'queue_full'
    | 'wait_timeout'
    | 'admission_closed'
    | 'rate_limit'
    | 'server_error'
    | 'timeout'
    | 'transport'
    | 'stream_closed'
    | 'circuit_open'
    | 'stream_stall';
  updatedAt: number;
  nextActionAt?: number;
  retry?: ProviderRecoveryRetryV1;
  admission?: ProviderRecoveryAdmissionV1;
  circuit?: ProviderRecoveryCircuitV1;
  stall?: ProviderRecoveryStallV1;
  fallback?: ProviderRecoveryFallbackV1;
}
~~~

The nested structures contain only the existing bounded operational fields:

- `retry`: `attempt`, `maxRetries`, optional `statusCode`, `delayMs`,
  `recoveryBudgetMs`, `recoveryElapsedMs`, and `recoveryRemainingMs`;
- `admission`: request class, scope, resource, queue position/depth, in-flight count,
  limit, elapsed wait, maximum wait, and optional recovery time remaining;
- `circuit`: public phase, optional status code, retry delay, next probe time, open
  duration, sample count, failure count, and optional recovery time remaining;
- `stall`: count, observed duration, warning threshold, timeout, and whether output
  started;
- `fallback`: source and target `{ provider, model }` identities, one-based candidate
  number, total candidate count, and a bounded trigger source/reason.

Numeric fields must be finite non-negative integers, counters must use explicit upper
bounds, and timestamps must be finite Unix milliseconds. `generation` is an opaque,
runtime-created identifier with a small maximum length. Provider and model identity
are normalized by removing control characters, trimming whitespace, and truncating
to 256 UTF-16 code units before they enter the projection. The schema does not have
extension properties or any field capable of carrying raw error text, headers,
credentials, a URL, or an action supplied by a backend.

`fallback` is contextual state, not always the primary activity. For example, after
Blade selects fallback candidate two and that candidate is waiting to retry,
`activity` is `retry_wait`, while `fallback` still identifies candidate two. This
avoids losing the selected model while giving the UI one unambiguous primary message.

## Typed Fallback Event

Replace `StreamChunk.modelFallback?: boolean` with an optional typed
`ProviderFallbackEvent`, and change the loop event from an empty
`{ kind: 'model_fallback' }` to that payload. It contains only:

~~~ts
interface ProviderFallbackEvent {
  from: { provider: string; model: string };
  to: { provider: string; model: string };
  candidate: number;
  candidateCount: number;
  trigger:
    | { source: 'retry'; reason: ProviderRetryReason; statusCode?: number }
    | { source: 'circuit'; reason: ProviderRetryReason; statusCode?: number }
    | {
        source: 'admission';
        reason: 'queue_full' | 'wait_timeout' | 'closed';
      }
    | { source: 'stall'; reason: 'timeout' };
}
~~~

`PiAIChatService` derives the trigger from the classified failure it already permits
to cross the fallback boundary. It must not infer a trigger by serializing the thrown
error. For a fallback chain, `from` is the candidate that just failed rather than
always the configured primary. The fallback event is emitted before starting the
target candidate, as it is today, and does not itself authorize another replay.

## Runtime Ownership and Generation Fencing

Add a focused `ProviderRecoveryState` unit under `src/agent/runtime`. It owns a pure
reducer and an in-memory holder; it does not call Provider APIs or know about UI.

At the start of each top-level Session `Agent.chatStream()` call, the runtime creates
a new opaque generation and publishes a revision-zero `snapshot: null` projection.
The returned generation token is required for all later updates. Within a generation,
every accepted change increments `revision`. Starting a new generation invalidates
the old token before publishing the reset. Events carrying an invalidated token are
ignored and cannot mutate or publish runtime state.

The Runtime publishes each accepted projection once on the Session `Bus`. This is the
cross-surface path: a run owned by ACP can still be observed by a Web client. The
Agent also yields the unified `provider_recovery` loop event to its direct consumer.
The Web run adapter must not emit a second copy of that event; it relies on the Bus.
Existing `provider_admission`, `provider_retry`, `provider_circuit`,
`provider_stall`, and typed `model_fallback` events remain available to direct
consumers for compatibility.

The runtime holder exposes only:

- `beginProviderRecovery(): ProviderRecoveryGeneration`;
- `observeProviderRecovery(generation, event): projection | undefined`;
- `clearProviderRecovery(generation): projection | undefined`;
- `getProviderRecoveryProjection(): projection`.

`getProviderRecoveryProjection()` always returns a validated defensive copy. No
consumer receives the mutable internal object.

## State Reduction

The reducer tracks the nested operational states and derives one primary `activity`
using this precedence: stall, circuit wait/probe, retry wait/attempt, admission wait,
then fallback context.

- `provider_admission.queued` enters `admission_wait`.
- `provider_admission.admitted` removes admission state; it preserves any retry or
  fallback context.
- `provider_admission.rejected` records the bounded rejection long enough to project
  it; the enclosing terminal path then clears the generation.
- `provider_retry.scheduled` and `.waiting` enter `retry_wait`.
- `provider_retry.attempt` enters `retry_attempt`.
- `provider_retry.recovered` removes retry and circuit state.
- `provider_retry.exhausted` retains the bounded final condition until the enclosing
  failure or fallback event advances it.
- circuit `opened`, `reopened`, `waiting`, and `rejected` enter `circuit_open`;
  `probe` enters `circuit_probe`; `closed` removes circuit state.
- `provider_stall.detected` enters `stream_stall`; `.recovered` removes stall state.
- `model_fallback` removes the failed candidate's admission, retry, circuit, and stall
  state, stores the typed fallback context, and enters `fallback`.

The first non-empty content delta, non-empty thinking delta, tool start, structured
output, or successful stream end clears recovery state. This is the evidence that the
selected candidate is making useful progress. A recovered stall without subsequent
output removes only the stall state, so fallback context remains accurate.

Normal completion, failure, cancellation, Session replacement, runtime disposal, and
consumer-initiated generator close all call `clearProviderRecovery()` from `finally`.
Clear is idempotent. A clear for an invalidated generation is ignored.

## Surface Behavior

### TUI

The TUI store receives only the unified projection as its rendering authority. The
existing fine-grained handlers may remain as compatibility no-ops during this patch,
but they must no longer independently decide when the visible state is clear.

`LoadingIndicator` gains a bounded, at-most-two-line recovery presentation:

- a primary explanation such as "请求受限，32 秒后重试", "Provider 暂时不可用，
  等待探测", "输出停滞，正在等待数据", or "正在切换到 deepseek-reasoner";
- a secondary line for attempt count, remaining recovery budget or queue position,
  followed by the existing `Esc 停止` affordance.

`ChatStatusBar` keeps a compact summary. At narrow widths, countdown and stop guidance
take priority over model identity and secondary counters. Countdown rendering derives
from `nextActionAt` using a local one-second clock; the Runtime does not emit per-second
events. Escape continues through the existing abort path and does not gain a new
cancellation protocol.

### Web GUI

Add a `ProviderRecoveryBanner` immediately above the composer and keep a compact
summary in `StatusBar`. The banner renders the same reason, countdown, retry/budget or
queue details, and fallback target as TUI. It has `role="status"`,
`aria-live="polite"`, and a fixed local **Stop** action wired to the existing run-stop
API. No URL or command can arrive through the recovery payload.

The Session SSE `connected` object includes the runtime's current projection. A full
page reload or EventSource reconnect therefore hydrates the current authoritative
state before later events. The Web store accepts a revision only when it is newer for
the current generation; a new authoritative `connected` snapshot replaces local
state. Normal live Bus ordering supplies new generations, while the Runtime has
already rejected events from invalidated generations.

After terminal failure, the banner disappears and existing task retry,
edit-and-resend, draft restore, and model-settings controls remain responsible for
recovery. The banner never offers an immediate model switch or forced replay.

### ACP

ACP sends `_meta['blade/providerRecovery']` for each unified projection and sends the
current projection alongside its existing initial follow-up queue metadata. Existing
fine-grained `_meta` keys remain backward compatible. Typed fallback is no longer
silently ignored. ACP clients observe the state; cancellation continues through the
standard ACP cancel operation.

### Headless

JSONL output adds `provider_recovery` with the version, generation, revision, and
snake-case bounded snapshot. A clear is represented by `snapshot: null`. Human text
output uses one concise stderr line on state changes and does not print a line for
local countdown ticks. Fine-grained output remains compatible.

## Error, Cleanup, and Privacy Boundaries

- Projection validation failure is fail-closed: log a fixed diagnostic, clear the
  in-memory snapshot, and never forward the rejected object.
- Rendering failure cannot affect the active Provider request.
- A reconnect cannot extend a retry budget; countdowns use absolute runtime
  timestamps and are display-only.
- Stopping a run clears the projection even if the Provider abort itself throws.
- Terminal errors continue through existing task failure channels. The recovery
  projection never carries their free-form message.
- Provider identity contains only normalized catalog provider/model names. Channel
  keys, base URLs, API versions, service credentials, custom headers, request bodies,
  and response bodies are excluded by construction.
- Recovery state is not written to transcript events, Session metadata, config,
  localStorage, or TUI attention files.

## TDD and Verification

### Deterministic Tests

1. TypeBox parsing accepts every valid activity and rejects unknown properties,
   non-finite numbers, oversized identities, URLs, and accidental secret-bearing
   fields.
2. Pure reducer tables cover admission, retry, circuit, stall, fallback, precedence,
   recovery, and terminal clear transitions.
3. A stale generation and an old revision cannot change or publish the current
   snapshot.
4. Success, failure, abort, runtime disposal, and early generator return each produce
   a final clear.
5. Fallback events contain exact source/target catalog identity and bounded classified
   trigger, never channel configuration or raw errors.
6. Session SSE `connected` returns an active snapshot and returns a clear projection
   when idle.
7. TUI and Web render all primary activities, update local countdowns, invoke existing
   stop behavior, and remove the surface on clear.
8. Web accepts only a newer revision within a generation and lets an authoritative
   reconnect snapshot replace stale client state.
9. ACP initialization/live updates and headless JSONL project the same versioned
   object; typed fallback is observable.
10. Existing fine-grained Provider lifecycle tests remain green.

### GUI and Terminal Journeys

- Run the production Web build in Chromium and assert admission/retry/circuit/stall
  banners, fallback target, countdown, Stop, SSE disconnect/reconnect hydration, and
  cleanup after recovery.
- Run the built CLI under a raw PTY and assert visible bounded recovery text, narrow
  terminal layout, Escape cancellation, fallback identity, and absence of stale text
  after recovery.
- Use screenshots only as secondary evidence; assertions must also inspect accessible
  text/state and the actual stop result.

### Real API Qualification

Extend `foreground-provider-recovery-trajectory.test.ts` and its production runners.
The local fault proxy injects a bounded number of 429/503 responses or a controlled
stall and then forwards the request to the configured real DeepSeek endpoint. The
release matrix covers DeepSeek Flash/Pro across headless, ACP, raw PTY TUI, and
production Chromium Web according to the existing release-matrix policy.

The trajectory must prove:

- the Runtime projection follows the actual recovery path;
- Web reconnect hydrates an in-progress snapshot;
- TUI and Web expose an actionable stop control;
- fallback identity and ACP/headless structured updates are observable;
- exactly one terminal assistant response is committed;
- retry and fallback do not cross the established replay boundary;
- transcripts, protocol output, logs, and screenshots contain no configured secret or
  injected private response marker.

### Repository Gates

Run focused RED/GREEN tests first, then:

~~~bash
bun run build
bun run type-check
bun run lint
bun run test:all
~~~

Before release, perform a prompt-to-artifact audit mapping Runtime ownership, typed
fallback, Web GUI, TUI/PTY, ACP, headless, reconnect, cleanup, privacy, real API, and
bilingual documentation requirements to concrete files and command evidence.

## Documentation and Release Boundary

Update the Chinese and English model-transport-recovery reference pages and both
source changelogs. Do not edit generated docs changelogs. This is one independent
feature patch after `v0.10.136`; version `0.10.137` is bumped only after all gates and
the completion audit pass. Release remains an annotated `v0.10.137` tag consumed by
`publish.yml`; no manual npm publish, moved tag, or rewritten prior release is allowed.
