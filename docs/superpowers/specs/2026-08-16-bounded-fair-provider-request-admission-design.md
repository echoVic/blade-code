# Bounded Fair Provider Request Admission Design

**Date:** 2026-08-16
**Target:** `blade-code@0.10.40`
**Status:** Frozen for implementation

## Problem

`blade-code@0.10.39` coordinates replay-safe Provider outages with one
process-wide circuit per failure domain. It decides whether a physical
attempt should exist after shared failures are known. It does not bound how
many healthy or not-yet-classified physical streams can start at once.

In a long-running Web or ACP process, multiple Sessions and their subagents
can therefore enter the same channel concurrently:

```text
Session A root + background children
Session B root + background children
Session C scheduled/internal work
  -> same endpoint/model/credential
  -> every request starts a Provider stream immediately
```

Before four failures open the circuit, this creates a capacity amplification
window:

- one Session can occupy every connection the Provider or gateway will
  accept;
- background and internal work can delay user-blocking root turns;
- simultaneous first attempts can turn normal queue pressure into `429`,
  `529`, gateway `5xx`, connection resets, and circuit trips;
- each retry can overlap with unrelated Sessions;
- a process can retain an unbounded number of waiting request closures if
  admission is added as an ordinary semaphore without queue bounds;
- Session cancellation and process shutdown need an explicit way to remove
  queued work before it reaches the network;
- a fallback or half-open probe must not bypass the same physical-stream
  capacity boundary.

Circuit breaking and request admission remain separate controls:

```text
admission: may this physical stream run now?
circuit: should this failure-domain stream exist at all?
retry: may this logical request create another replay-safe attempt?
```

## Reference Evidence

The reference revisions audited for this design are:

| Runtime | Revision |
| --- | --- |
| Claude Code | `c7db3b2ed99036afadcf60f2334db39fe62d2530` |
| Neovate Code | `0a24b363ecbe24eb87a0190a88fcb78c80593b4b` |
| Codex | `2cc9dbb9846b2dc03948414df6712adb967c70eb` |
| Grok Build | `b13fa526f5112c0b20dad5f1f2300d3d3b127895` |

### Claude Code

`src/services/api/withRetry.ts` distinguishes user-blocking work from
background amplification:

- foreground sources may retry `529`;
- non-foreground sources fail immediately during a capacity cascade;
- short `Retry-After` values stay on the same fast path;
- long or unknown delays enter a process-visible cooldown;
- persistent waits are chunked into heartbeat intervals;
- cancellation interrupts every wait.

Claude does not expose a general multi-Session Provider semaphore, but its
source classification and background shedding prove that user-blocking work
must retain capacity independently from maintenance traffic.

### Codex

Codex uses bounded concurrency and separate control capacity in several
runtime boundaries:

- `exec-server/request_dispatcher.rs` separates ordinary and control
  semaphores so health and cleanup remain live;
- memory extraction uses a fixed concurrency cap and durable claims;
- memory startup checks Provider rate-limit snapshots and skips background
  work below a configured remaining budget;
- request and task ownership is held for the complete operation lifetime.

The explicit TODO for bounded queued request bytes is also a useful control:
a semaphore alone does not bound retained pending work.

### Neovate Code

`src/loop.ts` owns cancellable exponential backoff and retry UI projection,
but Provider attempts remain per-loop and have no shared admission boundary.
This is the control showing that cancellable retry alone cannot prevent
cross-Session concurrency amplification.

### Grok Build

`xai-computer-hub-sdk/src/admission.rs` provides the strongest admission
ownership reference:

- fixed-order multi-scope permit acquisition;
- one deadline spanning every scope;
- process, connection, and Session limits;
- RAII ownership for the complete call lifetime;
- bounded wait followed by a typed overload error;
- per-Session entry cleanup;
- cancellation and shutdown removal;
- metrics that distinguish queued, running, and rejected work.

Blade adopts the multi-scope and single-deadline properties, but uses a
bounded fair scheduler instead of nested semaphores. Nested semaphores can
hold a local permit while waiting for a broader scope and cannot express
foreground reservation or cross-Session round-robin selection without
additional queues.

## Scope

Included:

- one process-wide Provider request admission scheduler;
- one configurable active-stream limit per sensitive failure domain;
- one hard process-wide active-stream limit;
- root Session owner limits inherited by all descendant subagents;
- foreground, background, and internal request classes;
- reserved capacity for foreground root progress;
- bounded global, failure-domain, and owner pending storage;
- cross-owner round-robin with bounded class aging;
- one monotonic admission deadline;
- cancellation-safe queue removal and idempotent permit release;
- admission around every physical primary, retry, fallback, and probe stream;
- circuit preflight before queueing and atomic circuit recheck after permit
  acquisition;
- typed Headless, TUI, Web, Server SSE, ACP, and subagent projection;
- deterministic bounds, fairness, deadline, race, fallback, and cleanup
  tests;
- DeepSeek Flash/Pro real-API qualification through all four production
  entrypoints;
- same-domain multi-Session controls in Web and ACP.

Excluded:

- cross-process or distributed admission;
- requests-per-minute or token-per-minute shaping;
- persistence of active permits or pending tickets across process restart;
- changing circuit thresholds or foreground retry budgets;
- preempting an already-running Provider stream;
- replay after any Provider output;
- exposing endpoint, credential, routing headers, failure-domain digest,
  owner ID, or Session ID in admission events;
- admission for non-Provider HTTP traffic, tools, MCP, shells, or LSP.

Cross-process coordination requires a durable lease or external coordinator
and has different crash semantics. RPM/TPM shaping requires trustworthy
Provider quota metadata. Both remain independent features.

## Frozen Configuration and Bounds

```ts
export const DEFAULT_PROVIDER_REQUEST_CONCURRENCY = 4;
export const MIN_PROVIDER_REQUEST_CONCURRENCY = 1;
export const MAX_PROVIDER_REQUEST_CONCURRENCY = 16;

export const DEFAULT_PROVIDER_REQUEST_ADMISSION_MS = 180_000;
export const MIN_PROVIDER_REQUEST_ADMISSION_MS = 1_000;
export const MAX_PROVIDER_REQUEST_ADMISSION_MS = 600_000;

export const PROVIDER_ADMISSION_GLOBAL_MAX_IN_FLIGHT = 16;
export const PROVIDER_ADMISSION_GLOBAL_MAX_PENDING = 128;
export const PROVIDER_ADMISSION_DOMAIN_MAX_PENDING = 32;
export const PROVIDER_ADMISSION_OWNER_MAX_IN_FLIGHT = 3;
export const PROVIDER_ADMISSION_OWNER_MAX_PENDING = 16;

export const PROVIDER_ADMISSION_NON_FOREGROUND_GLOBAL_MAX_IN_FLIGHT = 12;
export const PROVIDER_ADMISSION_NON_FOREGROUND_OWNER_MAX_IN_FLIGHT = 2;
export const PROVIDER_ADMISSION_INTERNAL_GLOBAL_MAX_IN_FLIGHT = 2;
export const PROVIDER_ADMISSION_INTERNAL_DOMAIN_MAX_IN_FLIGHT = 1;

export const PROVIDER_ADMISSION_HEARTBEAT_MS = 15_000;
export const PROVIDER_ADMISSION_AGING_MS = 30_000;
```

User configuration:

```json
{
  "providerRequestConcurrency": 4,
  "providerRequestAdmissionMs": 180000
}
```

`providerRequestConcurrency` must be a safe integer from 1 through 16. This is
a core process safety boundary and cannot be disabled. Setting 16 provides
the least restrictive supported policy.

`providerRequestAdmissionMs=0` makes pressure fail fast without disabling
active-stream bounds. Any positive value must be a safe integer from 1,000
through 600,000 milliseconds.

Each Session freezes both values in its immutable runtime configuration. The
policy values participate in failure-domain identity, so a live Session
cannot have its queue semantics changed by a later config reload.

### Rationale

- Four streams per failure domain permit useful root/subagent overlap while
  bounding the first-failure amplification window.
- Sixteen global streams allow four fully active domains without scaling with
  Session count.
- Three active streams per root owner ensure one Session cannot occupy all
  four default domain slots.
- Non-foreground work may use at most 12 global slots and, when a domain has
  more than one slot, at most `domainLimit - 1`. This leaves four global
  slots and one slot per default domain for foreground work.
- A concurrency of one cannot reserve a second slot; background/internal work
  may use the single slot, and a later foreground request waits for normal
  release.
- Internal work is capped at two process-wide and one per domain.
- Pending bounds permit bursts without retaining an unbounded set of
  messages, contexts, promises, timers, or AbortSignal listeners.
- The 180-second wait is a leak-prevention bound, not an ordinary request
  timeout. The Provider request timeout starts only after admission.

## Failure-Domain Identity

Admission uses the same canonical sensitive route dimensions as the shared
circuit:

```text
provider channel
wire API
canonical base URL
model
service tier
API version or deployment
explicit credential
custom routing headers
configured admission policy
```

The circuit and admission modules share one canonicalization helper to prevent
identity drift. Each registry uses its own process-random 32-byte secret and
HMAC-SHA-256 digest.

Raw identity fields and digests never enter:

- logs or diagnostics;
- Headless JSONL;
- TUI state or capture;
- Web SSE, DOM, or reload state;
- ACP metadata;
- subagent events;
- transcript, checkpoint, or Session metadata;
- Provider-visible messages.

Admission domain state exists only while active or queued work references it.
Idle domain and owner entries are deleted synchronously. With 16 active and
128 pending requests, the scheduler can retain at most 144 referenced domain
or owner entries.

## Admission Owner

Every request carries two internal identities:

```ts
interface ProviderAdmissionIdentity {
  sessionId: string;
  ownerId: string;
}
```

`sessionId` identifies the current root or child Session. `ownerId` is the
root Session that owns the complete Agent tree.

Rules:

- a root turn uses its own Session ID as owner;
- a direct Task/Team child inherits the parent request's owner;
- every nested descendant propagates the same owner unchanged;
- resume preserves the stored owner;
- legacy child metadata without an owner falls back to its immediate parent;
- internal compaction uses the owning root Session;
- PromptHook uses its owning Session;
- Provider health uses one stable internal owner per model config;
- direct `PiAIChatService` consumers receive one stable service-scoped owner,
  not a new synthetic owner per request.

The owner is runtime-only. It may be persisted only in the private bounded
subagent sidecar required to preserve tree ownership across resume; it is not
part of public Session APIs or Provider payloads.

## Request Classes

```ts
export type ProviderRequestClass =
  | 'foreground'
  | 'background'
  | 'internal';
```

Classification:

- `foreground`: root Agent turns and root-blocking compaction;
- `background`: Task/Team subagents, verification agents, and PromptHook
  sampling;
- `internal`: health probes and model sampling not required to continue an
  active user turn.

Unknown call paths default to `internal`. A new request origin must opt into
`foreground`; it cannot inherit foreground capacity accidentally.

The overall global/domain/owner limits apply to every class. Additional class
limits apply to non-foreground and internal work. There is no separate
unbounded maintenance lane.

## Scheduler State

The process-wide scheduler owns:

```ts
interface ProviderAdmissionState {
  globalInFlight: number;
  globalNonForegroundInFlight: number;
  globalInternalInFlight: number;
  queue: PendingProviderAdmission[];
  domains: Map<OpaqueDomainKey, DomainState>;
  owners: Map<OwnerId, OwnerState>;
  lastAdmittedOwnerOrder: number;
}
```

Each pending record stores only:

- an opaque domain key;
- internal Session and owner identity;
- request class;
- enqueue/deadline monotonic timestamps;
- bounded snapshot fields;
- one Promise resolver/rejecter;
- one timer;
- at most one AbortSignal listener.

It does not copy messages, tools, Provider options, credentials, or response
data.

## Scheduling Policy

### Immediate admission

A request starts immediately only when:

1. the queue is empty;
2. global capacity is available;
3. failure-domain capacity is available;
4. root-owner capacity is available;
5. its class-specific capacity is available.

New arrivals never bypass an existing eligible queue.

### Foreground reservation

For `background` and `internal` requests:

```text
global non-foreground < 12
owner non-foreground < 2
domain non-foreground < max(1, domainLimit - 1)
```

Internal work additionally requires:

```text
global internal < 2
domain internal < 1
```

Foreground work is constrained only by the overall global/domain/owner
limits.

### Fair selection

The queue exposes one eligible request per root owner: the request with the
best effective class, breaking equal-class ties by owner-local FIFO order.
This lets foreground work use its reserved capacity when an older background
request from the same owner is class-capped, without reordering equally ranked
work. Eligible owner candidates are ranked by effective class:

```text
foreground = 0
background = 1
internal = 2
```

Every complete 30 seconds of queue age promotes one class level until the
request reaches foreground rank. Candidates at the same effective rank use a
stable owner round-robin cursor.

This provides:

- immediate foreground preference under ordinary pressure;
- no unbounded starvation for background or internal work;
- no FIFO burst monopolization by one Session tree;
- deterministic selection without a sweep timer.

The scheduler drains only on enqueue, release, cancellation, timeout, or
close. Aging is evaluated when drain runs; it does not require an interval
timer.

## Ticket and Permit Ownership

Admission returns a ticket:

```ts
interface ProviderAdmissionTicket {
  readonly ready: Promise<ProviderAdmissionPermit>;
  getSnapshot(): ProviderAdmissionQueueSnapshot;
  cancel(reason?: unknown): void;
}

interface ProviderAdmissionPermit {
  release(): void;
}
```

The ticket snapshot is either immediately admitted or queued. Queue-full
rejection occurs before registering a timer or AbortSignal listener.

The permit is:

- acquired before constructing the physical pi-ai stream;
- held through response headers, every stream event, completion, and error
  classification;
- released before retry backoff, fallback delay, or circuit waiting;
- idempotently released in `finally`;
- never transferred between logical attempts.

Caller abort while queued removes the exact ticket, clears its timer and
listener, and rethrows the caller's abort reason. It does not emit a capacity
rejection.

Queue timeout and queue overflow throw `ProviderAdmissionError`:

```ts
class ProviderAdmissionError extends Error {
  readonly code = 'PROVIDER_ADMISSION_BUSY';
  readonly retryable = true;
}
```

The error contains only reason, scope, counts, and limits. It contains no
domain or owner identity.

## Circuit Interaction

Known circuit state must be checked before queueing without claiming an
attempt or HalfOpen probe. `ProviderCircuitHandle` therefore adds a
non-mutating preflight operation:

```ts
preflight(): ProviderCircuitPreflight
```

Preflight behavior:

- Closed: eligible for admission;
- Open before deadline: blocked with the existing retry metadata;
- Open at/after deadline: eligible to queue, but no probe is claimed;
- HalfOpen with a live probe: blocked;
- HalfOpen without a live probe: eligible to queue;
- detached/no-op: eligible.

The physical attempt sequence is:

```text
1. circuit.preflight()
2. if blocked -> existing wait/fallback/fail-fast behavior
3. request Provider admission
4. if queued -> typed queued event + 15s heartbeat
5. acquire permit
6. circuit.check() atomically
7. if blocked by a race -> release permit and return to step 1
8. construct and consume exactly one pi-ai stream
9. classify circuit outcome
10. abandon/settle circuit token and release permit in finally
```

This ordering prevents:

- a known Open candidate from waiting behind healthy work;
- queued requests from holding circuit attempt tokens;
- a HalfOpen probe from being claimed before physical capacity exists;
- a request admitted before an outage from bypassing a newly Open circuit;
- probe owners from exceeding Provider concurrency.

## Retry, Fallback, and Deadline Semantics

Admission queueing does not increment physical attempt counts because no
Provider request exists yet.

Every retry, fallback, and HalfOpen probe independently reacquires admission.
No permit is held during:

- exponential backoff;
- circuit Open wait;
- fallback selection;
- compaction;
- tool execution.

An admission error on a non-terminal candidate is fallback-eligible. A
fallback with another failure-domain key competes for its own domain capacity
while still obeying global and owner limits.

When bounded foreground recovery has started:

- admission wait counts against the existing monotonic recovery budget;
- the ticket deadline is the minimum of admission wait and recovery
  remaining;
- recovery budget expiry emits the existing
  `provider_retry.exhausted/recovery_budget`, not a misleading admission
  timeout;
- admission never resets or extends retry or recovery deadlines.

Initial foreground admission before any Provider failure uses only the
configured admission deadline. Provider request and stream-idle timers start
after the permit is acquired.

## Typed Event

```ts
export type ProviderAdmissionPhase =
  | 'queued'
  | 'admitted'
  | 'rejected';

export type ProviderAdmissionScope =
  | 'global'
  | 'domain'
  | 'owner'
  | 'class';

export interface ProviderAdmissionEvent {
  phase: ProviderAdmissionPhase;
  requestClass: ProviderRequestClass;
  scope: ProviderAdmissionScope;
  reason?: 'capacity' | 'queue_full' | 'wait_timeout' | 'closed';
  queuePosition: number;
  queueDepth: number;
  inFlight: number;
  limit: number;
  waitMs: number;
  maxWaitMs: number;
  recoveryRemainingMs?: number;
}
```

Rules:

- immediate admission emits no event;
- queue entry emits `queued`;
- every complete 15-second wait emits another `queued` heartbeat with a fresh
  snapshot;
- a previously queued request emits `admitted` before circuit recheck;
- overflow, wait timeout, or scheduler close emits `rejected`;
- caller abort emits no rejected event;
- all numbers are finite, nonnegative, safe integers and clamped to configured
  hard bounds;
- owner/domain identity and raw Provider data are absent.

`StreamChunk` carries `providerAdmission`. The Agent loop projects:

```ts
{ kind: 'provider_admission', ...event }
```

## Surface Projection

### Headless

JSONL emits:

```json
{
  "type": "provider_admission",
  "data": {
    "phase": "queued",
    "requestClass": "foreground",
    "scope": "domain",
    "reason": "capacity",
    "queuePosition": 1,
    "queueDepth": 1,
    "inFlight": 1,
    "limit": 1,
    "waitMs": 0,
    "maxWaitMs": 120000
  }
}
```

Text mode writes one bounded status line to stderr. It never writes admission
metadata to assistant stdout.

### TUI

`LoadingIndicator` and Web `StatusBar` priority is:

```text
action stationarity > circuit > provider admission > provider retry
  > provider stall > ordinary
```

Queued state shows capacity scope, queue position, elapsed wait, and Esc
cancellation. Admitted/rejected/completion/cancellation clears transient
state.

### Web

Server SSE emits `provider.admission`. The Session store retains only the
current transient event. `StatusBar` renders queue/admission state inline and
clears it on admitted, terminal run state, task reset, Session switch, and
reload.

Admission state is not reconstructed from transcript on fresh load.

### ACP

ACP emits `session_info_update` metadata:

```json
{
  "blade/providerAdmission": {
    "phase": "queued",
    "requestClass": "foreground",
    "scope": "domain",
    "queuePosition": 1,
    "queueDepth": 1,
    "inFlight": 1,
    "limit": 1,
    "waitMs": 0,
    "maxWaitMs": 120000
  }
}
```

It emits no assistant text chunk. Terminal state emits `null` to clear the
metadata.

### Subagent SSE

Subagent event forwarding uses `subagent.provider.admission` with the same
sanitized fields and exact child Session routing. Parent and sibling state
must not cross.

## Deterministic Tests

### Scheduler

- frozen constants and config validation;
- global, domain, owner, non-foreground, and internal active limits;
- foreground reserved capacity;
- concurrency-one degradation without deadlock;
- global/domain/owner pending overflow before timer/listener allocation;
- immediate admission cannot bypass an existing eligible queue;
- root-owner round-robin across Session trees;
- foreground priority;
- 30-second background/internal aging;
- one monotonic deadline across all constraints;
- queued caller abort removal;
- wait timeout;
- idempotent permit release;
- observer exceptions do not alter ownership;
- idle owner/domain entry deletion;
- active + pending state never exceeds 144 referenced domains/owners;
- close rejects pending work and future requests.

### Tree ownership

- root requests use root Session owner;
- direct and nested Task descendants preserve one owner;
- Team members preserve the lead owner;
- resume preserves private sidecar owner;
- legacy sidecars fall back to immediate parent;
- another root Session receives a distinct owner;
- owner identity never enters public Session metadata or transcript.

### PiAIChatService

- immediate permit surrounds exactly one physical stream;
- queued work starts no Provider request;
- permit releases on success, Provider error, caller abort, idle timeout,
  recovery deadline, fallback, and iterator close;
- retry sleep holds zero permits;
- fallback reacquires against its own domain;
- admission queueing does not increment attempt count;
- queue timeout on primary reaches fallback;
- bounded recovery clamps admission deadline;
- circuit preflight blocks without queueing;
- queueing holds no circuit token;
- post-permit circuit race releases capacity and sends zero Provider traffic;
- exactly one HalfOpen probe owns both circuit token and admission permit;
- replay boundary remains unchanged.

### Surface

- one schema across Headless, TUI, Web, ACP, and subagent SSE;
- every JSONL `data` value is an object;
- queued heartbeat updates wait and position;
- admitted, rejected, completion, cancellation, reset, Session switch, and
  reload clear state;
- metadata never enters assistant content;
- domain, owner, endpoint, credential, routing header, HMAC, raw error, and
  Provider body leak searches remain empty.

### Source gates

Search gates reject:

- direct pi-ai physical streams outside admission;
- unbounded pending arrays or Maps;
- `Infinity` admission limits;
- one synthetic owner per call;
- Session disposal closing the process-global scheduler;
- permits held across sleep or fallback;
- circuit probe claim before Provider permit;
- test-only production bypasses;
- public serialization of owner/domain identity.

## Real API Qualification

The release-blocking feature matrix is:

```text
DeepSeek V4 Flash/Pro
  x Headless JSONL
  x raw PTY TUI
  x production Chromium Web
  x real ACP stdio
```

Every cell uses:

```json
{
  "providerRequestConcurrency": 1,
  "providerRequestAdmissionMs": 120000
}
```

The transparent loopback proxy records request arrival, in-flight count, and
release barriers while forwarding admitted requests to the real Provider.

### Web and ACP

Each model cell creates two Sessions in one process:

1. Session A starts a real Provider request held at the proxy barrier;
2. Session B submits on the same failure domain;
3. Session B observes typed `queued`;
4. the proxy proves no Session B request arrived before release;
5. Session A is released and obtains a real Provider result;
6. Session B emits `admitted`, reaches the proxy, and obtains its own real
   Provider result;
7. both Sessions retain independent final state;
8. Web reload and ACP session/load preserve final results without transient
   admission state.

### Headless and TUI

These entrypoints host one root Session. Their fixture creates overlap through
the production background Task path:

1. the root receives one deterministic Task tool call;
2. the child starts a real Provider request held at the proxy;
3. the parent continues and queues its next same-domain physical request;
4. Headless/TUI projects `queued` while the proxy still sees one request;
5. release lets the child complete;
6. the parent emits `admitted`, consumes the durable child completion, and
   obtains a real final Provider result;
7. raw PTY renders queue state and Esc without Yoga failure.

The deterministic Task trigger may be supplied by the proxy, but the held
child and final parent requests must reach the configured real DeepSeek
Provider. A synthetic-only cell is invalid.

### Required proof

Every cell proves:

- proxy maximum same-domain in-flight is exactly one;
- no queued request reaches the network;
- queue event precedes admitted event;
- both real Provider requests complete independently;
- Provider attempt counts exclude queue waits;
- no framework retry is used;
- no transcript contains admission metadata;
- no key or private proxy body reaches JSONL, ACP, DOM, PTY, diagnostics, or
  evidence;
- proxy, socket, browser, page, SSE reader, ACP terminal/process, PTY,
  temporary HOME/storage/workspace, and Session resources are reclaimed.

The feature matrix is an additive release-blocking file in
`test:real-api:qualification`; it does not replace the existing 102 tests.

## Failure Modes

### Foreground arrives after background saturation

Non-foreground caps leave reserved capacity when domain concurrency is above
one. The foreground request starts without waiting for a background stream to
finish.

### Concurrency is configured to one

No second slot exists to reserve. The current background/internal stream
finishes normally; foreground waits under the same bounded ticket contract.

### One root spawns many children

All descendants share the root owner. At most two non-foreground and three
total streams from that tree can run. Pending work is bounded to 16 and is
round-robined against other owners.

### Queue fills with many failure domains

Global pending is checked before creating new domain/owner state. The 129th
pending request receives a typed global `queue_full` error with no timer,
listener, or retained domain entry.

### Circuit opens while a request is queued

The request acquires a permit, atomically rechecks the circuit, releases the
permit, and follows existing circuit wait/fallback semantics. It sends zero
Provider traffic.

### Probe waits for capacity

Preflight does not claim the probe. The probe is claimed only after Provider
capacity exists, so an admission queue cannot strand HalfOpen ownership.

### Caller aborts while queued

The exact ticket is removed synchronously. Timer and listener are cleared.
No `rejected` capacity event or Provider request is emitted.

### Iterator consumer stops early

Async generator `finally` abandons the circuit token and releases the permit
even when the caller does not drain the Provider stream.

### Admission timeout occurs during foreground recovery

If the recovery deadline wins, the existing recovery-budget terminal event is
authoritative. If the admission deadline wins first, the typed admission
timeout is fallback-eligible and does not consume a physical attempt.

## Release Gate

Before tagging:

1. design, scheduler, owner propagation, service, config, and surface tests
   pass;
2. focused deterministic suites prove every frozen bound and race;
3. the eight-cell real-API matrix passes with zero framework retry;
4. Web/ACP multi-Session and Headless/TUI parent-child controls all pass;
5. existing retry, circuit, stall, compaction, output, handoff, shutdown,
   Goal, subagent, TUI, Web, and ACP controls remain green;
6. `bun run qualify:production` passes all checks;
7. evidence is written to
   `docs/testing/bounded-fair-provider-request-admission-evidence.md`;
8. package, lockfile, and built CLI are `0.10.40`;
9. npm fresh install reports `0.10.40`;
10. feature worktree, branch, proxy, browser, PTY, profile, process, and
    temporary roots are removed.
