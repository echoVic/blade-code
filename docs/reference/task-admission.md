# Top-level Task Admission

Blade uses one process-wide FIFO scheduler for top-level task Sessions created
by Web Task Home, Headless task mode, ACP task Sessions, and durable task
recovery.

## Bounds

| Resource | Default | Range |
| --- | ---: | ---: |
| Active tasks | 3 | 1-64 |
| Pending task tickets | 100 | 1-10,000 |
| Pending retained footprint | 64 MiB | 64 KiB-128 MiB |

Settings:

```json
{
  "maxConcurrentTasks": 3,
  "maxQueuedTasks": 100,
  "maxQueuedTaskBytes": 67108864
}
```

The equivalent CLI overrides are:

```text
--max-concurrent-tasks
--max-queued-tasks
--max-queued-task-bytes
```

All three settings are process-wide. Project and Session-local configuration
cannot override them.

## Retained Footprint

Pending ticket count and retained bytes are independent hard limits. A queued
task owns:

- its prompt and multimodal content;
- structured-output schema and durable input metadata;
- the Runtime or durable inbox projection;
- the waiting `Agent.chatStream()` or Web run projection.

Blade estimates direct, Web-prepared, and recovered durable input with one
cycle-safe, getter-safe, 100,000-node-bounded traversal. The scheduler receives
only a numeric weight and never stores the prompt, attachment, schema,
Session, Runtime, or worktree graph.

The estimator conservatively reserves two projections of the logical input.
It saturates at the hard maximum plus one instead of traversing or copying an
unbounded graph.

## Admission

When active capacity is available, a task starts immediately and has no
pending-byte charge. A single task may therefore be larger than the pending
budget without being rejected.

When all active slots are occupied:

1. pending count is checked;
2. pending retained bytes are checked;
3. the task is charged and appended to FIFO only if both checks pass.

Count overflow is reported as `pending_count`; byte overflow is reported as
`pending_bytes`. Rejection happens before queue/listener/key allocation.

Queued-to-running promotion releases the pending byte charge before resolving
the task's admission Promise. Explicit cancellation, AbortSignal cancellation,
release-before-execution, and coordinated shutdown release the same exact
charge.

Lowering the configured byte limit does not evict already accepted durable
tasks. New tasks are rejected until the queue drains below the new limit.

## Recovery

Queued task input is durable. After restart, the Agent resumes with
`pendingInputOnly=true` and an empty synthetic message, but admission weight is
calculated from the recovered inbox content, schema, and metadata. Recovery
cannot bypass accounting through the empty message.

Startup retains stable FIFO order. A task that is too large to wait can still
run immediately on a later recovery when an active slot is available.

## Overload Surfaces

Web task dispatch returns:

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

The rejected Web task is deleted together with its inbox, Runtime, and
worktree. Task Home renders the error inline and reload does not create a
ghost task.

Headless and ACP task Sessions persist the canonical retryable failure:

```json
{
  "code": "capacity",
  "message": "Task admission capacity is full. Retry after running tasks complete.",
  "retryable": true,
  "resource": "pending_bytes"
}
```

ACP projects it through namespaced task metadata without assistant-text
pollution. Headless keeps existing queued/running `task_admission` events and
uses the same durable terminal task failure.

The interactive root TUI is not a top-level task Session and is not charged by
this scheduler.

No public overload event contains actual task weight, aggregate pending bytes,
configured byte limits, prompt/attachment/schema content, Session identity,
workspace path, endpoint, or credential.

## Qualification

Release qualification covers:

- exact and one-over count/byte boundaries;
- immediate oversized admission;
- queued oversized rejection;
- promotion, cancel, abort, reset, and reconfiguration settlement;
- direct, prepared, and recovered input estimation;
- Web 429 ghost cleanup;
- ACP durable `capacity/pending_bytes`;
- DeepSeek Flash/Pro production Chromium Task Home and real ACP target cells;
- DeepSeek Flash/Pro Headless task-mode and raw PTY non-interference controls;
- existing production Web worktree coding and normal FIFO promotion.

Every feature target and control runs with framework retry disabled and
reclaims task Runtime, worktree, browser/ACP process, Provider proxy, socket,
port, HOME, storage, and workspace resources.
