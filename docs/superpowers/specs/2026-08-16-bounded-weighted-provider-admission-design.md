# Bounded Weighted Provider Admission Design

**Date:** 2026-08-16
**Target:** `blade-code@0.10.41`
**Status:** Frozen for implementation

## Problem

`blade-code@0.10.40` bounds active Provider streams and pending ticket counts.
The scheduler retains only opaque identity and timing metadata, but every
queued caller still owns an async stack containing the complete logical
request:

```text
Message[] + normalized pi-ai Context + tool schemas + request options
  -> streamChat() waits on Provider admission
  -> scheduler retains one small ticket
  -> caller retains the full request graph until admitted, cancelled, or timed out
```

Ticket-count bounds therefore do not establish a memory bound. With the
production global limit of 128 pending tickets, large contexts, image data
URLs, parsed historical tool arguments, and tool catalogs can retain hundreds
of MiB while no Provider request is running.

The pending count policy has a second liveness gap. Active capacity reserves
space for root foreground work, but pending capacity does not:

```text
128 tiny background tickets
  -> global pending count full
  -> a root foreground request cannot even join the fair queue
```

Priority and aging cannot help work that was rejected before queue admission.
Production admission must bound both queue cardinality and retained request
footprint while preserving pending capacity for user-blocking root progress.

## Reference Evidence

The reference revisions audited for this design are:

| Runtime | Revision |
| --- | --- |
| Claude Code | `c7db3b2ed99036afadcf60f2334db39fe62d2530` |
| Neovate Code | `0a24b363ecbe24eb87a0190a88fcb78c80593b4b` |
| Codex | `2cc9dbb9846b2dc03948414df6712adb967c70eb` |
| Grok Build | `b13fa526f5112c0b20dad5f1f2300d3d3b127895` |

### Blade

`BoundedSerialEgress` already treats item count and UTF-8 bytes as independent
hard limits. It validates size before retaining a value, charges bytes
atomically with enqueue, releases bytes on delivery or failure, and exposes
both counters in deterministic stats.

The Provider scheduler has equivalent count accounting but no byte weight:

- `PendingAdmission` stores no retained-footprint number;
- `DomainState` and `OwnerState` track only queued count;
- `getStats()` cannot prove pending memory ownership;
- foreground reservations apply only to active streams;
- queue-full checks run before timer/listener allocation, which is the correct
  boundary for adding byte and class admission.

`createPiContext()` also proves why the footprint must be measured after
normalization:

- system messages are joined into a new system prompt;
- remote images are fetched and converted to base64;
- historical tool-call arguments are parsed into new objects;
- context messages and tool definitions coexist with the original `Message[]`
  for the complete wait.

### Codex

`exec-server/server/request_dispatcher.rs` has an explicit production TODO:

```text
bound queued request bytes without blocking later responses or cleanup
```

Its HTTP response body implementation supplies the ownership pattern:

- one shared 16 MiB byte semaphore;
- a queued delta acquires a permit equal to its retained byte length;
- the permit lives inside the queued value;
- channel-count and byte-budget exhaustion are separate failures;
- the route is closed when either bound is exceeded;
- every response stream shares the same byte budget.

Blade adopts weighted queue ownership, but performs synchronous accounting
inside its existing fair scheduler instead of introducing a second semaphore.

### Grok Build

`xai-file-utils::queue::UploadQueue` maintains both `pending` and
`pending_bytes` from enqueue acceptance until terminal settlement:

- over-budget work is diverted before staging;
- failed enqueue rolls `pending_bytes` back;
- active work remains a subset of pending ownership;
- settlement decrements active, count, and bytes in fixed order;
- queue memory pressure is observable without logging payload content.

Grok's computer-hub admission also confirms that class-independent count
semaphores are insufficient for foreground reservation. Blade keeps one
scheduler so count, bytes, class, owner, domain, and global constraints are
checked atomically.

### Claude Code

Claude Code does not expose a shared Provider byte queue. Its retry policy
still supplies the class contract:

- background `529` work is shed instead of amplifying a capacity cascade;
- foreground persistent waits receive heartbeat progress;
- cancellation interrupts every wait;
- local and remote MCP startup use separate concurrency ceilings.

The control is relevant here: non-user-blocking work must not consume all
pending memory or ticket capacity needed by the root turn.

### Neovate Code

Neovate owns cancellable retry inside each loop but has no process-wide
Provider queue. It therefore has no cross-Session retained-byte accounting.
This is the negative control showing that bounded per-loop retry does not
bound a persistent server's aggregate queued request memory.

## Scope

Included:

- one logical retained-footprint estimate per `streamChat()` call;
- no payload copy or `JSON.stringify()` during footprint calculation;
- cycle-safe, node-bounded traversal with fail-closed saturation;
- one numeric `pendingBytes` weight passed to every physical admission
  attempt;
- configurable global pending-byte budget with a production hard maximum;
- hard domain and root-owner pending-byte ceilings;
- count and byte reservations for foreground work;
- stricter count and byte ceilings for internal work;
- exact byte accounting on enqueue, queued-to-active transition, caller
  abort, timeout, close, and rejection;
- immediate oversized requests when active capacity is available;
- typed distinction between active-stream, pending-count, and pending-byte
  pressure;
- Headless, TUI, Web, SSE, ACP, and subagent projection of the sanitized
  pressure kind;
- deterministic estimator, scheduler, service, config, surface, and leak
  tests;
- DeepSeek Flash/Pro real-API saturation trajectories through Headless, raw
  PTY TUI, production Chromium Web, and real ACP;
- the existing positive admission and long-task controls.

Excluded:

- heap-size measurement, V8 retained-size introspection, or garbage collection
  control;
- exact Provider wire-body serialization;
- requests-per-minute or tokens-per-minute shaping;
- cross-process or distributed memory coordination;
- preemption of active Provider streams;
- persistence of pending memory ownership across restart;
- logging request bytes, prompt size, image size, owner ID, domain key, or
  Session ID;
- changing active-stream, circuit, retry, or recovery limits;
- queueing payloads inside the scheduler.

The scheduler receives only a numeric weight. It never owns messages, context,
tools, images, schemas, or request options.

## Frozen Configuration

```ts
export const DEFAULT_PROVIDER_REQUEST_PENDING_BYTES = 128 * 1024 * 1024;
export const MIN_PROVIDER_REQUEST_PENDING_BYTES = 64 * 1024;
export const MAX_PROVIDER_REQUEST_PENDING_BYTES = 128 * 1024 * 1024;
```

The public setting is:

```json
{
  "providerRequestPendingBytes": 134217728
}
```

It must be a safe integer in `65536-134217728`. It cannot disable the core
memory bound. Active Sessions retain the frozen setting from their model
configuration snapshot.

The configured value is the request's global pending-byte ceiling. Derived
ceilings are:

```text
global = configured value, hard max 128 MiB
domain = min(global, 64 MiB)
owner  = min(global, 32 MiB)
```

Different frozen Session policies remain safe in one process:

- every request is checked against its own configured ceiling;
- all requests still contribute to the same process counters;
- no request can raise the process hard maximum;
- the failure-domain key includes the configured byte policy so domain
  accounting cannot silently merge incompatible policies.

## Frozen Pending Reservations

### Count

Existing total limits remain unchanged:

| Scope | Total | Non-foreground | Internal |
| --- | ---: | ---: | ---: |
| Global | 128 | 96 | 16 |
| Failure domain | 32 | 24 | 4 |
| Root owner | 16 | 12 | 4 |

This reserves at least 32 global, 8 domain, and 4 owner tickets for
foreground. Internal work cannot consume the complete non-foreground lane.

### Bytes

Class ceilings are derived from each request's effective total:

```text
non-foreground global = floor(global * 3 / 4)
non-foreground domain = floor(domain * 3 / 4)
non-foreground owner  = floor(owner  * 1 / 2)

internal global = max(1, floor(global / 8))
internal domain = max(1, floor(domain / 4))
internal owner  = max(1, floor(owner  / 4))
```

At production defaults this yields:

| Scope | Total | Non-foreground | Internal |
| --- | ---: | ---: | ---: |
| Global | 128 MiB | 96 MiB | 16 MiB |
| Failure domain | 64 MiB | 48 MiB | 16 MiB |
| Root owner | 32 MiB | 16 MiB | 8 MiB |

Aging changes scheduling rank only. It never changes the request's accounting
class, so aged background or internal work cannot consume a foreground
reservation.

## Request Footprint

The estimator runs once after `createPiContext()` and before the first circuit
or Provider admission decision:

```text
estimate([
  original filtered messages,
  normalized pi-ai context,
  tool definitions,
  request options
])
```

The result is reused by primary, retry, fallback, and HalfOpen probe attempts.
It is a logical retained-footprint weight, not a heap profiler.

### Traversal Rules

- strings use exact UTF-8 byte length;
- `Buffer`, typed arrays, `DataView`, and `ArrayBuffer` use raw byte length;
- numbers and bigints charge 8 bytes;
- booleans and null charge 4 bytes;
- arrays, maps, sets, and objects charge fixed structural overhead;
- enumerable own property keys are charged as UTF-8;
- object identity is counted once through `WeakSet`;
- primitive strings may be conservatively counted more than once;
- property getters are never invoked;
- functions, symbols, and weak collections are not traversed;
- cycles terminate through identity tracking;
- traversal stops at 100,000 nodes or at the process hard maximum plus one;
- saturation returns `MAX_PROVIDER_REQUEST_PENDING_BYTES + 1`.

The estimator allocates no serialized payload. It must not log or return any
content, key name, credential, endpoint, header, model-visible control, or
object path.

Overestimation is safe: it may reject waiting under extreme pressure but
cannot permit the process to exceed the logical budget. Immediate active work
is still allowed.

## Admission Algorithm

The physical-attempt order remains:

```text
circuit preflight
Provider admission
atomic circuit check
physical Provider iterator
settle circuit token and active permit
```

Admission now distinguishes immediate and pending ownership:

1. validate request identity, active policy, wait policy, and numeric weight;
2. compute the opaque failure-domain key;
3. if the fair queue is empty and active constraints allow the request,
   acquire the active permit immediately without charging pending count or
   bytes;
4. if waiting is required, evaluate class count reservations;
5. evaluate total count bounds;
6. evaluate class byte reservations;
7. evaluate total byte bounds;
8. only after all checks pass, create domain/owner state, Promise, timer, and
   abort listener;
9. atomically charge count and bytes at global/domain/owner and class scopes;
10. enqueue and drain.

Pending capacity checks happen before retained scheduler allocation. A
request that exceeds the global pending-byte ceiling may still run when
active capacity is immediately available. It cannot wait, because waiting
would violate the queue memory contract.

Existing queued work is never bypassed. If a large request cannot fit the
fair queue, it receives a typed overload error and sends no Provider traffic.

## Settlement

Each pending record owns one immutable `pendingBytes` number. The following
paths release it exactly once:

- queued request becomes active;
- caller signal aborts;
- explicit ticket cancellation;
- admission deadline expires;
- scheduler close;
- queue rejection during shutdown.

Queued-to-active transition performs:

```text
remove queue record
decrement global/domain/owner pending count and bytes
clear timer and abort listener
acquire active count permit
resolve ticket
```

Accounting state is retained across that transition until active acquisition
succeeds. Idle domain/owner state is removed after settlement. Counters use
safe non-negative arithmetic in production and exact equality assertions in
tests; silent underflow is not an accepted invariant.

Immediate requests never increment pending counters. Active requests are
bounded by existing stream counts rather than pending bytes.

## Error and Event Contract

Add:

```ts
export type ProviderAdmissionResource =
  | 'stream'
  | 'pending_count'
  | 'pending_bytes';
```

`ProviderAdmissionError` and `ProviderAdmissionEvent` carry one required
`resource` field:

- `stream`: active capacity wait, timeout, admission, or scheduler close;
- `pending_count`: total or class ticket bound;
- `pending_bytes`: total or class retained-footprint bound.

The existing reason remains:

```text
queue_full | wait_timeout | closed
```

Byte saturation uses `queue_full` plus `resource: pending_bytes`. The error
remains retryable unless the scheduler is closed. It is fallback-eligible and
does not count as a physical Provider attempt.

If retry and fallback selection still terminate in `queue_full`, the Agent
records `turn_aborted(cause=failed)` and acknowledges only the input claimed
by that turn. Web reload, SSE reconnect, and ACP load therefore cannot replay
the rejected request around the admission boundary. Provider outage,
`wait_timeout`, caller cancellation, and process crash retain their existing
recoverable-input behavior.

No event exposes:

- request footprint;
- aggregate pending bytes;
- configured byte limit;
- endpoint, credential, routing header, HMAC, owner, or Session identity.

The existing queue position, depth, in-flight count, active limit, wait, and
recovery fields remain sanitized. `resource` is the only new public field.

## Surface Projection

### Headless

JSONL adds:

```json
{
  "type": "provider_admission",
  "phase": "rejected",
  "request_class": "background",
  "resource": "pending_bytes",
  "scope": "class",
  "reason": "queue_full"
}
```

Root events and background-child events use the same JSONL schema. Headless
forwards only events for its current Session/workspace and omits child Session
identity. Text mode emits one bounded stderr status/error and no assistant
content.

### TUI

`provider_admission` remains transient. Queue waiting retains its current
status line. A background-child pending-byte rejection uses the existing
terminal child-failure path; the store never persists byte counters or payload
size.

### Web

SSE carries `resource`. The Session store retains only active queued state;
admitted or rejected events clear it, and the existing terminal error path
renders failure. Reload restores no admission state. No request-size
information enters DOM text.

### ACP

`blade/providerAdmission` metadata adds `resource`. Rejection and terminal
clear use the existing metadata lifecycle and produce no assistant text
chunk.

### Subagents

`subagent.provider.admission` carries the same field. Root and child
projection remain schema-identical.

## Deterministic Tests

### Footprint Estimator

- exact UTF-8 accounting;
- base64 strings and typed-array bytes;
- structural overhead;
- repeated object identity;
- cycles;
- getter avoidance;
- map/set traversal;
- node-limit saturation;
- byte-limit saturation;
- no payload copy or `JSON.stringify()` source gate;
- no credentials or object paths in failures.

### Scheduler

- exact global/domain/owner byte boundary;
- one-byte overflow at each scope;
- exact non-foreground and internal count reservation;
- exact non-foreground and internal byte reservation;
- foreground joins while non-foreground count is saturated;
- foreground joins while non-foreground bytes are saturated;
- aged background remains charged to non-foreground;
- immediate oversized request is admitted;
- the same request is rejected when waiting is required;
- queue-full rejection allocates no timer/listener/domain/owner state;
- queued-to-active releases pending bytes before Promise resolution;
- abort, cancel, timeout, close, and shutdown release exactly once;
- concurrent release/drain cannot underflow;
- idle state cleanup;
- hard maxima cannot be raised through injected options.

### Service

- footprint is computed once per logical `streamChat()`;
- retry, fallback, and probe reuse the same weight;
- byte rejection starts no pi-ai stream;
- byte rejection does not increment physical attempt count;
- fallback remains eligible;
- recovery deadline remains authoritative;
- payload and runtime controls stay disjoint.

### Configuration

- default, minimum, and maximum values;
- invalid, fractional, negative, zero, infinite, and over-hard-max values;
- CLI settings, user/project layers, workspace trust, and frozen model
  snapshots;
- public config serialization;
- legacy config normalization.

### Surfaces and Search Gates

- Headless JSONL snake-case schema;
- TUI event handling and terminal cleanup;
- Web SSE/store/StatusBar cleanup and reload;
- ACP metadata and terminal null;
- root and subagent SSE equality;
- terminal queue-full input acknowledgement without `turn_completed`;
- no pending-byte counters or request sizes in public payloads;
- no raw request graph in scheduler records;
- no direct pi-ai stream bypass.

## Real API Qualification

Use DeepSeek V4 Flash and Pro through a loopback recording proxy. The test
configuration sets:

```json
{
  "providerRequestConcurrency": 1,
  "providerRequestAdmissionMs": 120000,
  "providerRequestPendingBytes": 65536
}
```

Each negative cell creates a normalized context whose logical footprint is
greater than 64 KiB through bounded project instructions and user text.

### Headless and raw PTY

1. the root request is admitted immediately despite its large footprint;
2. the model starts one background child and completes independent parent
   work;
3. the parent's next physical request is admitted and held by the proxy;
4. the background child attempts its first physical request while capacity is
   occupied;
5. the child needs to wait and is rejected with
   `requestClass=background`, `resource=pending_bytes`;
6. no child request reaches the proxy, while the held parent request may
   complete normally after release;
7. the failed child sidecar records the exact pending-byte reason and Headless
   forwards schema-valid child admission JSONL without child identity;
8. raw PTY proves both the sidecar reason and a visible child failure without
   a fatal Yoga error;
9. caller, child, proxy, PTY, process tree, HOME, storage, and workspace are
   reclaimed.

### Web and ACP

1. Session A starts one real Provider request and the proxy holds it;
2. Session B submits a large request in the same production process;
3. Session B receives typed pending-byte rejection;
4. Session B creates zero Provider traffic;
5. Session A is released and obtains a real Provider final result;
6. both Session transcripts remain isolated;
7. Web submits Session B through the production Chromium composer, observes
   SSE/terminal state, reloads, proves the rejected marker is not replayed,
   and reports zero console/page errors;
8. ACP uses two real stdio Sessions and emits metadata without assistant-text
   pollution, then loads Session B and proves the rejected marker is not
   replayed.

The frozen negative matrix is:

```text
DeepSeek Flash/Pro
  x Headless parent-child
  x raw PTY parent-child
  x production Chromium Web dual Session
  x real ACP dual Session
```

All eight cells run with `--retry=0`.

Positive controls retain the complete `0.10.40` admission matrix at production
defaults:

- Headless and raw PTY parent-child completion;
- production Web parent-child completion and reload;
- ACP durable wake-up control;
- Web and ACP dual-root serialization;
- maximum same-domain in-flight count one;
- queued-to-admitted transition after release.

The negative cells prove memory rejection. The positive controls prove the
new byte policy does not narrow normal production progress.

## Failure Modes

### One request is larger than the pending-byte budget

It runs if active capacity is immediately available. If it must wait, it
receives `queue_full/pending_bytes` and sends no Provider traffic.

### Background fills its pending reservation

Additional background work is rejected at `scope=class`. Total count and byte
capacity remain available to foreground.

### Internal work ages to foreground rank

It may be selected ahead of newer work, but it remains charged to internal
count and bytes. Aging cannot bypass reservations.

### Circuit opens while a weighted request is queued

The request releases pending bytes when admitted, acquires an active permit,
fails the atomic circuit recheck, releases active capacity, and sends zero
Provider traffic.

### Caller aborts during footprint calculation

Context normalization already observes the caller signal for image fetches.
The estimator is synchronous and bounded. The following scheduler call sees
the aborted signal and retains nothing.

### Caller aborts while queued

The exact ticket is removed synchronously. Count, bytes, timer, and listener
are released before any later drain.

### Fallback follows byte rejection

The rejection consumes no attempt and holds no pending ownership. A distinct
fallback candidate independently requests admission with the same logical
weight and its own failure-domain policy.

### Configured budget changes during a Session

The active Session keeps its frozen snapshot. New Sessions use the new value.
The process hard maximum remains unchanged.

## Release Gate

Before tagging:

1. estimator, scheduler, class reservation, config, service, and surface tests
   pass;
2. every count and byte hard boundary has exact and one-over tests;
3. abort, timeout, close, queued-to-active, retry, fallback, and circuit races
   have exact accounting assertions;
4. the eight-cell negative real-API matrix passes with zero framework retry;
5. the complete positive Provider admission matrix remains green;
6. Headless, raw PTY, production Chromium Web, and real ACP prove the same
   typed resource semantics;
7. `bun run qualify:production` passes all checks;
8. evidence is written to
   `docs/testing/bounded-weighted-provider-admission-evidence.md`;
9. package, lockfile, and built CLI are `0.10.41`;
10. npm fresh install reports `0.10.41`;
11. feature worktree, branch, proxy, browser, PTY, profile, process, and
    temporary roots are removed.
