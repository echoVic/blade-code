# Tool Concurrency Model

Blade uses uniform in-batch scheduling semantics for multiple tool calls in the same model response. CLI/TUI, Web, Headless, and ACP all go through the same `StreamingToolExecutor` and `ToolExecutor`; execution order does not change based on entry point.

## Two-Layer Concurrency Properties

Tools have two orthogonal properties:

- `parallelism: shared | exclusive` controls the in-batch gate. Consecutive `shared` tools can execute simultaneously; `exclusive` tools form a FIFO barrier that subsequent shared tools cannot cross.
- `isConcurrencySafe` controls whether pre-launch is allowed before provider stream commit, and whether path locks are required. `false` does not mean the entire batch must be serialized.

Tools that do not declare `parallelism` maintain compatibility: `isConcurrencySafe: true` is inferred as `shared`, other tools default to `exclusive`.

## Bounded Admission

ToolExecutor acquires four types of permits simultaneously before actually entering external invocation:

```text
Session total
Session kind
process total
process kind
```

Production defaults are all bounded:

| Scope | total | readonly | write | execute | pending |
| --- | ---: | ---: | ---: | ---: | ---: |
| Process-wide | 32 | 24 | 8 | 3 | 256 |
| Per-Session | 10 | 8 | 4 | 2 | 64 |

The deadline for waiting for permits is 180 seconds. The per-Session execute limit of 2 ensures one Session cannot fill all three global Bash slots; another Session can immediately use remaining global capacity even when the former already has queued items.

validation, workspace isolation, hooks, permission resolution, and human approval occur before scarce permits. Waiting for user confirmation does not occupy global tool execution capacity long-term. Permits are held from invocation launch until Promise settle; success, failure, throw, timeout, and cancellation all release exactly once.

### Background Shell Admission

Foreground Bash auto-handoff and explicit background Bash use independent bounded capacity outside tool permits:

| Scope | active background shells |
| --- | ---: |
| Process-wide | 16 |
| Per-Session | 4 |

Hidden foreground candidates count against this capacity before spawn, preventing multiple concurrent handoffs from piercing the limit. Natural exit, spawn/release failure, timeout, abort, KillShell, and Session dispose all release exactly once. Explicit background overflow returns `resource_exhausted/background_shell_busy` before user command launch; auto-handoff overflow retains original foreground ownership without restarting the command. Foreground tool permits are released only after handoff identity is committed, while background capacity is held until process/ACP terminal terminal state.

## Built-in Tool Policies

- Read, Glob, Grep, and other pure read tools are `shared` and can be stream-prelaunched in the explicit allowlist.
- Write, Edit, and NotebookEdit are `shared`, but the same path is serialized through the global `FileLockManager`; different paths can run in parallel.
- Bash is `shared`, constrained by both Session execute=2 and process-wide execute=3.
- Task is `shared`; each call owns an independent durable child session. Parallel children that may modify code must still use `isolation: "worktree"`.
- Plan switching, configuration changes, user questions, and other shared state operations remain `exclusive`.

## Session Fairness

Pending work maintains arrival order within each Session, and the scheduler round-robins between Sessions:

1. Each drain first considers the first item of work for each Session;
2. Each round admits at most one item from one eligible Session, then moves to the next Session;
3. A Session blocked by local total/kind limits cannot block other eligible Sessions;
4. abort, deadline, or owner dispose immediately re-drains after removing queue items;
5. Tool results are still projected in original Provider tool-call order, not written back to model in completion order.

`ownerId` and `sessionId` are separate: `sessionId` determines fairness and local capacity, `ownerId` is only used to delete queue entries retained by ToolExecutor dispose. Another executor for the same Session is not cancelled as a side effect.

## Streaming Commit Boundary

Pure read allowlist tools can launch before the complete model response arrives. Non-prelaunched tools must wait for the provider stream to end successfully before batch dispatch, avoiding fallback or incomplete response replay side effects.

If an exclusive tool is already queued in the stream, subsequent read tools also enter the queue, preventing reads from crossing write barriers. Fallback increments executor epoch, aborts old-generation calls, and discards their results.

Each Provider response admits at most 64 function tool calls. The 65th item and beyond return `resource_exhausted/tool_batch_full` without entering gate, permission, durable tool-use preflight, or scheduler; each Provider tool-call ID still receives a complete result. Fallback and discard reset the next-generation 64-item budget.

Streaming and non-streaming paths only serialize durable tool-use commits, not external tool execution. Therefore JSONL call parts, result parts, resume history, and surface results maintain Provider order, while different tools can still run in parallel after their respective identities are persisted.

## Results and Cancellation

- Tools requiring user confirmation are serially approved per ToolExecutor, preventing multiple simultaneous interactions across Web/TUI/ACP; approved shared tools can still execute in parallel.
- Tools can complete out of order by completion time, but durable call/result, model history, and frontend events maintain original tool-call order.
- Calls waiting at the gate immediately return `abortedBeforeLaunch` after receiving abort, without waiting for preceding long tasks.
- scheduler queue overflow and wait timeout return retryable `resource_exhausted/tool_busy`; metadata includes `reason/scope/kind/limit/retryable`; the tool does not launch and PostToolUseFailure hook is not executed.
- queued progress uses `Waiting for tool execution capacity`, carrying scope, kind, queue position, current in-flight, and actual constraint limits. Headless JSONL uses snake_case, TUI/Web in-memory projection uses camelCase, ACP uses standard `tool_call_update`.
- `ToolConcurrencyGate` retains at most 64 pending calls. close cleans up all waiter listeners and rejects subsequent calls; active invocations are managed by their owning turn AbortSignal.
- Single tool failure does not erase results from other tools in the same batch; all results form complete tool-call boundaries.
- Web stores multiple subagent cards by child session/tool-call ID; TUI uses a keyed progress map; ACP maintains independent `tool_call` IDs.

## Qualification Verification

Deterministic tests cover all total/kind/pending limits, mixed-kind totals, three-Session round-robin, no head-of-line blocking, queue overflow, deadlines, queued abort, owner dispose, listener/timer cleanup, shared/exclusive gates, same-path locking, 64-call streaming/non-streaming parity, fallback generation reset, ordered durable commits, and production bypass search gating.

Release-blocking real API fixed runs cover DeepSeek Flash/Pro × Headless, real ACP stdio, raw PTY TUI, and production Chromium Web GUI in an eight-cell matrix. Each cell issues four real foreground Bash calls in one Provider response; the host proves only two launch initially, only one successor is admitted per release, peak is 2, call/result order is consistent, and all resources are reclaimed.

Additional production Chromium traces run two live Sessions simultaneously: A occupies two execute slots and queues a third, B must use the remaining global slot and complete independently first. Both Sessions reload after completion, verifying durable history, SSE/GUI progress, foreground leases, server/browser/port, and credential reclamation.
