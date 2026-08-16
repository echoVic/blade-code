# Bounded Weighted Task Admission Design

**Target:** `blade-code@0.10.42`
**Status:** Frozen for implementation
**Capability:** Bounded Weighted Top-level Task Admission

## Problem

Blade already limits process-wide top-level task execution by active and
pending ticket count:

```text
default active = 3
default pending = 100
configured active = 1..64
configured pending = 1..10,000
```

Ticket count is not a retained-memory bound.

One task request may contain:

- a 32,000-character prompt;
- up to 20 inline attachments;
- up to 5 MiB of aggregate inline attachment content;
- a structured-output schema;
- task dispatch metadata;
- one durable inbox projection;
- one `executeRunAsync()` or `Agent.chatStream()` caller stack retaining the
  logical input while admission waits.

At the default queue size, large queued task inputs can retain hundreds of
MiB. At the configured count maximum, the count-only contract is not a
meaningful memory bound.

The ownership exists on every task entry path:

- Web creates the durable task, inbox, Runtime, and optional worktree before
  `startRun()` calls `TaskRunScheduler.admit()`;
- Headless task mode calls `Agent.chatStream()` with the complete input before
  its task admission await;
- ACP can own several task Sessions in one process and call `prompt()`
  concurrently;
- crash recovery calls `Agent.chatStream()` with an empty synthetic message
  while the complete task input remains in the recovered durable inbox.

The recovery path is especially important. Estimating only the
`chatStream(message)` argument would assign a recovered queued task a near-zero
weight and bypass the new limit.

## Reference Audit

### Blade

`TaskRunScheduler` has the correct basic lifecycle:

- one process-wide active limit;
- one process-wide pending ticket limit;
- FIFO order;
- cancellation through one AbortSignal listener;
- idempotent permit release;
- queue position projection;
- durable task status before and after promotion;
- startup recovery in stable FIFO order.

The missing state is retained bytes:

```text
PendingAdmission {
  key
  listener
  callbacks
  snapshot
}
```

The scheduler holds no payload, but the Promise caller that waits on
`admission.ready` retains the payload graph. Therefore accounting belongs in
the scheduler even though storage remains caller-owned.

The durable steering inbox is not the gap. It already has:

- user and background-completion count limits;
- content, schema, and metadata budgets;
- an 8 MiB file-size hard limit;
- atomic fsync persistence;
- crash reconciliation and acknowledgement.

### Codex

Codex uses bounded `mpsc::channel` queues and non-blocking `try_send` at
several process boundaries. Its exec-server additionally gives queued HTTP
body deltas a shared byte semaphore and closes a stream when the byte budget
is exhausted.

The useful contract is:

- count and bytes are independent resources;
- queue admission acquires byte ownership before retaining the item;
- completion drops the byte permit;
- one slow stream cannot consume unlimited process memory.

Some Codex request dispatch paths still contain an explicit TODO to bound
queued request bytes. This is a useful negative control: bounded channel
cardinality alone does not bound caller-owned payload memory.

### Claude Code

Claude Code's `SerialBatchEventUploader` applies count-based backpressure:
`enqueue()` waits when `maxQueueSize` is reached and resumes after drain.
Batch size has an optional serialized-byte limit, but the pending queue itself
is count-only.

That design proves why the waiting caller must be included in memory
ownership. Blocking enqueue does not discard the payload; the async caller
continues to retain it.

Claude Code also uses bounded rings for long-lived deduplication state. It
does not expose a process-wide weighted top-level task scheduler that Blade
can reuse directly.

### Grok Build

Grok Build provides both relevant controls:

- bounded per-session inbox channels use non-blocking enqueue and typed
  overload responses;
- `UploadQueue` tracks both pending item count and `pending_bytes`.

`UploadQueue` increments bytes at accepted enqueue, rolls them back if enqueue
fails, and decrements them on completion. Its telemetry keeps payload bytes
separate from public payload content.

Blade adopts the weighted ownership and exact settlement contract, but keeps
its durable FIFO task semantics.

### Neovate

Neovate's UI queue appends to `queuedMessages` and later joins the entire
array. It has no count or byte hard limit. This is the negative control: a
convenient UI queue is not a production process admission boundary.

## Scope

This patch adds:

- one process-wide pending task byte budget;
- a bounded task-input footprint estimator;
- exact queued byte charge and release;
- direct, prepared, and recovered task input accounting;
- typed count-vs-byte overload classification;
- durable `capacity` task failure projection;
- Web REST, Web GUI, Headless, ACP, and TUI-compatible behavior;
- deterministic and real-Provider qualification.

This patch does not change:

- active task concurrency;
- pending task count defaults or ranges;
- FIFO scheduling order;
- task worktree isolation;
- task cancellation or startup recovery order;
- tool, Provider, subagent, MCP, or scheduled-task admission;
- maximum individual prompt or attachment sizes;
- distributed or cross-process admission.

## Configuration

Add one process-wide setting:

```ts
maxQueuedTaskBytes: number
```

Frozen constants:

```ts
export const DEFAULT_MAX_QUEUED_TASK_BYTES = 64 * 1024 * 1024;
export const MIN_MAX_QUEUED_TASK_BYTES = 64 * 1024;
export const MAX_MAX_QUEUED_TASK_BYTES = 128 * 1024 * 1024;
```

Rules:

- the value must be a safe integer;
- `0` cannot disable the core memory bound;
- project configuration cannot control this process-wide setting;
- the startup Store owns the process-wide value, using the same
  `TaskRunScheduler.configure()` semantics as the existing count limits;
- Session-local and project-local resource snapshots cannot override it;
- qualification uses the legal 64 KiB minimum.

Expose the setting through:

- `BladeConfig`;
- defaults;
- ConfigService metadata;
- ConfigManager validation and CLI merge;
- CLI `--max-queued-task-bytes`;
- settings schema;
- `/config` projection;
- user documentation.

The public `/info` task-capacity projection remains count-only. It must not
expose configured byte capacity or aggregate pending bytes.

## Generic Retained-value Estimator

The cycle-safe estimator added for Provider requests is generic runtime
infrastructure. Move it to:

```text
packages/cli/src/utils/retainedValueFootprint.ts
```

Keep the existing Provider export and behavior through a wrapper re-export so
there is no public or test churn.

The generic estimator retains the existing rules:

- exact UTF-8 bytes for strings;
- raw byte length for Buffer, typed arrays, DataView, and ArrayBuffer;
- fixed primitive and container overhead;
- enumerable own string keys only;
- no getter invocation;
- object identity deduplication and cycle termination;
- no traversal of functions, symbols, or weak collections;
- 100,000-node maximum;
- fail-closed saturation at `maxBytes + 1`;
- no `JSON.stringify()` of the full logical input;
- no payload copy.

## Task Footprint

Add:

```text
packages/cli/src/agent/runtime/taskRunFootprint.ts
```

The estimator accepts:

```ts
interface TaskRunFootprintInput {
  content: UserMessageContent;
  outputSchema?: JsonObject;
  pendingMessages?: readonly SteeringMessage[];
}
```

Root selection:

```text
pendingMessages non-empty
  -> every pending message content + output schema + metadata

otherwise
  -> direct content + output schema
```

The selected logical input is estimated once. The result is multiplied by two
with safe saturation at `MAX_MAX_QUEUED_TASK_BYTES + 1`.

The factor of two is a conservative ownership contract for:

1. the durable inbox or Runtime projection;
2. the waiting async caller/generator projection.

It intentionally overestimates Headless or ACP paths that temporarily retain
only one complete projection. A hard bound must be conservative; an
underestimate would make the configured limit false.

The function returns only a positive safe integer. It never returns the input
graph and the scheduler receives only the numeric weight.

## Scheduler Contract

Extend the scheduler request:

```ts
export interface TaskAdmissionOptions {
  key: string;
  maxConcurrent: number;
  maxQueued: number;
  maxQueuedBytes: number;
  pendingBytes: number;
  signal?: AbortSignal;
  onUpdate?: (snapshot: TaskAdmissionSnapshot) => void;
}
```

Extend process stats internally:

```ts
{
  inFlight: number;
  queued: number;
  pendingBytes: number;
  maxConcurrent: number;
  maxQueued: number;
  maxQueuedBytes: number;
}
```

`PendingAdmission` stores only:

- the existing key, signal, callbacks, and snapshot;
- numeric `pendingBytes`;
- one boolean indicating whether the queue charge is live.

It never stores prompt, attachment, schema, metadata, Session, Runtime, or
worktree objects.

## Admission Order

Admission is synchronous through the retention decision:

```text
validate limits and weight
apply process-wide configuration
validate nonblank key
reject duplicate key

if active capacity exists
  -> immediate active admission
  -> no pending count or byte charge

otherwise
  -> reject pending count overflow
  -> reject pending byte overflow
  -> create Promise/callback record
  -> attach AbortSignal listener
  -> charge pending bytes
  -> append FIFO record
  -> publish queue snapshots
```

Count overflow has precedence when both count and bytes are exhausted. This
keeps existing count-overflow behavior stable.

Queue-full rejection occurs before:

- Promise allocation;
- AbortSignal listener allocation;
- active-key insertion;
- queue append;
- pending byte mutation.

## Immediate Oversized Tasks

A single task larger than the pending byte budget may run when:

```text
inFlight < maxConcurrent
```

It receives an active permit immediately and has no pending charge.

This preserves large one-off coding tasks and makes the setting a queue-memory
limit rather than an input-size limit.

If active capacity is unavailable, the same task is rejected before queue
retention with:

```text
resource = pending_bytes
```

Existing FIFO work cannot be bypassed. Under the scheduler invariant, a
non-empty queue implies active capacity is occupied.

## Exact Settlement

Every accepted queued task has one exact byte charge.

Release paths:

- queued to active;
- explicit handle cancellation;
- caller AbortSignal;
- release-before-execution;
- scheduler test/reset cleanup.

Queued-to-active ordering:

```text
remove FIFO record
decrement pending bytes
detach queued abort listener
acquire active count
publish running snapshot
resolve ready Promise
```

Cancellation ordering:

```text
remove exact FIFO record
decrement pending bytes
mark settled
detach abort listener
remove active key
reject ready Promise
publish remaining queue snapshots
```

Byte accounting uses checked addition and subtraction. Underflow or an invalid
weight is a programmer error, not a silently clamped production state.

Reconfiguring to a lower byte limit does not evict already accepted durable
tasks. New queued work is rejected until pending bytes fall below the new
limit.

## Entry-point Ownership

### Web

After the durable input is prepared, `startRun()` estimates from:

```text
runtime.getPendingSteeringMessages()
```

This includes the exact durable content, output schema, and metadata that the
queued Runtime owns.

The scheduler rejects before `activeRuns` insertion and
`executeRunAsync()` creation when count or bytes are already full. Existing
cleanup removes the unaccepted Session, inbox, Runtime, and worktree.

### Headless

Headless task mode reaches `Agent.chatStream()` without an externally supplied
admission handle. The Agent estimates the direct message before
`chatStreamInternal()` prepares its durable turn.

An immediate task larger than the pending budget still runs because active
capacity is available.

### ACP

ACP can create multiple task Sessions in one process through:

```text
session/new _meta.blade/taskIsolation
```

Each concurrent `prompt()` reaches the shared scheduler. Direct prompts use
the same estimator as Headless. Queue byte overflow fails before Provider
traffic and becomes a typed durable task failure.

### TUI

The interactive root TUI is not a top-level task Session and does not consume
task admission. The new process setting must not affect ordinary root turns.

Raw PTY qualification is therefore a non-interference control, not a
manufactured task-queue target.

### Recovery

Startup task recovery invokes the Agent with `pendingInputOnly=true` and an
empty message. The Agent must use:

```text
runtime.getPendingSteeringMessages()
```

when that list is non-empty. Recovered prompt, attachment, output schema, and
metadata therefore retain the same weight as a live task.

No recovery path may pass a constant, zero, or empty-message-derived weight.

## Typed Overload Contract

Add:

```ts
export type TaskAdmissionResource =
  | 'pending_count'
  | 'pending_bytes';
```

`TaskAdmissionQueueFullError` contains:

- `resource`;
- the applicable numeric limit for internal diagnostics only.

No public projection contains:

- task weight;
- aggregate pending bytes;
- configured byte limit;
- prompt or attachment content;
- output schema;
- workspace path as overload detail;
- Session or run key.

### Durable Task Failure

Add task failure code:

```text
capacity
```

Canonical failure:

```json
{
  "code": "capacity",
  "message": "Task admission capacity is full. Retry after running tasks complete.",
  "retryable": true,
  "resource": "pending_count | pending_bytes"
}
```

`resource` is optional for all non-capacity failures and required when a
`TaskAdmissionQueueFullError` is classified.

Headless task JSONL, ACP Session metadata, Web task status, catalog replay,
and durable JSONL all use the same schema.

### Web REST

Web dispatch rejection remains HTTP 429 with code `TOO_MANY_REQUESTS`.
Extend error responses with optional sanitized details:

```json
{
  "error": {
    "code": "TOO_MANY_REQUESTS",
    "message": "Task admission capacity is full",
    "details": {
      "resource": "pending_bytes"
    }
  }
}
```

The Web store continues to show the message in the Task Home inline error
surface. No failed or ghost task card remains because the unaccepted task is
deleted.

## Surface Compatibility

### Headless

- queued and running `task_admission` output remains unchanged;
- terminal capacity failure uses the shared task failure schema;
- text output remains bounded;
- ordinary non-task Headless runs are unaffected.

### TUI

- ordinary root turns remain unaffected;
- task Session failure rendering uses the canonical capacity message if a
  task Session is resumed through a supported CLI path;
- no byte counts are rendered.

### Web

- Task Home displays the sanitized 429 message inline;
- no rejected task is inserted into the task list;
- queued/running capacity meter remains count-based;
- reload does not resurrect the rejected task.

### ACP

- `session_info_update` projects `blade/taskFailure`;
- capacity resource is typed;
- no assistant text chunk carries admission metadata;
- a rejected task prompt sends zero Provider traffic.

## Deterministic Coverage

### Configuration

- default, minimum, and maximum byte values;
- unsafe integer, zero, below-minimum, and above-maximum rejection;
- CLI and settings mapping;
- process startup configuration cannot be overridden by Session-local config;
- `/config` includes the setting while `/info` does not expose byte stats.

### Estimator

- direct text and multimodal input;
- UTF-8 non-ASCII content;
- output schema and metadata;
- factor-of-two ownership;
- byte and node saturation;
- recovered pending input overrides the empty synthetic message;
- no getter invocation or payload copy;
- one estimate per admission attempt.

### Scheduler

- exact byte limit acceptance;
- one-byte-over rejection;
- independent count and byte exhaustion;
- count precedence when both are exhausted;
- immediate oversized active task;
- queued oversized rejection;
- exact charge while queued;
- uncharge before queued-to-active Promise resolution;
- explicit cancel;
- AbortSignal cancel;
- release-before-execution;
- reset cleanup;
- observer exception isolation;
- lower reconfiguration without eviction;
- active permit idempotency;
- no timer, listener, key, queue, or byte mutation on rejection.

### Runtime and Surfaces

- Web prepared inbox weight;
- Agent direct task weight;
- Agent recovered inbox weight;
- Web 429 typed details and complete ghost cleanup;
- capacity task failure classification and durable schema;
- Headless event schema;
- ACP metadata schema;
- Web store translation and retryability;
- public source gates against payload, aggregate bytes, and configured limit
  projection.

## Real API Qualification

All target and control cells use:

- DeepSeek V4 Flash;
- DeepSeek V4 Pro;
- real Provider traffic through the configured production endpoint;
- a loopback recording proxy;
- `maxConcurrentTasks=1`;
- `maxQueuedTasks=100`;
- `maxQueuedTaskBytes=65,536`;
- framework retry disabled.

### Target Matrix

| Model | Surface | Required proof |
| --- | --- | --- |
| Flash | production Chromium Web Task Home | oversized second task is HTTP 429 `pending_bytes`, inline error visible, no ghost task, zero marker Provider traffic |
| Pro | production Chromium Web Task Home | same |
| Flash | real ACP stdio, two task Sessions | oversized second prompt becomes durable `capacity/pending_bytes`, zero marker Provider traffic |
| Pro | real ACP stdio, two task Sessions | same |

For each target:

1. task A starts one real Provider request and the proxy holds it;
2. task B contains a unique marker and enough non-ASCII text to exceed 64 KiB;
3. task B is rejected before Provider traffic;
4. task C is a normal small task and is accepted as queue position one;
5. releasing task A promotes task C;
6. task A and task C receive independent real Provider terminal results;
7. all task, Runtime, worktree, proxy, browser/ACP, socket, port, and temporary
   storage resources are reclaimed.

Web additionally proves:

- the task is submitted through the real Task Home composer;
- the production build runs in pinned Chromium;
- the inline overload error is visible;
- reload does not materialize task B;
- no console, page, request, or SSE error remains.

ACP additionally proves:

- task Sessions are created through `session/new` metadata;
- the rejected prompt has no assistant-text output;
- `session/list` retains the typed durable failure;
- the normal queued task receives queued then running metadata.

### Non-interference Controls

| Model | Surface | Required proof |
| --- | --- | --- |
| Flash | Headless task mode | ordinary immediate task completes with real Provider |
| Pro | Headless task mode | ordinary immediate task completes with real Provider |
| Flash | raw PTY root TUI | ordinary non-task coding turn completes |
| Pro | raw PTY root TUI | ordinary non-task coding turn completes |

Existing Web task-dispatch Flash/Pro trajectories remain release-blocking and
prove normal FIFO queued-to-running promotion under the default byte budget.

## Search Gates

Source tests reject:

- task scheduler payload fields;
- queued task weight derived from a constant or empty recovery message;
- unbounded or disabled task byte limits;
- `Infinity` or unsafe numeric limits;
- byte charge after listener or queue allocation;
- settlement paths that remove a queue record without uncharging bytes;
- public `pendingBytes`, `maxQueuedBytes`, task weight, prompt, attachment, or
  schema projection;
- count-only task admission call sites;
- production-only bypass flags.

## Release Gate

The patch may release only after:

1. focused deterministic tests pass;
2. full local qualification passes;
3. all four target cells pass with framework retry zero;
4. all four non-interference cells pass with framework retry zero;
5. existing Web task dispatch Flash/Pro controls pass;
6. Production Qualification passes every check and every release-blocking real
   API file;
7. build, full test suite, npm pack, fresh install, `blade --version`, and
   `blade --help` pass from the final release HEAD;
8. npm, annotated tag, GitHub Release, CI, coverage, docs, Pages, and
   Ubuntu/macOS/Windows smoke are verified;
9. worktree, branch, proxy, browser profile, PTY, ACP process, temp storage, and
   logs are reclaimed.

## Release Boundary

This patch is complete only when all task admission call sites provide a
bounded numeric weight, queued bytes settle exactly on every path, recovery
cannot bypass accounting, and the real Web/ACP target matrix plus
Headless/TUI controls pass without framework retry.
