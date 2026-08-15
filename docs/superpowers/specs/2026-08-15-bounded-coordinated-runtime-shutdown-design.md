# Bounded Coordinated Runtime Shutdown

Target: `blade-code@0.10.34`

## Problem

Blade durably records turn starts and can repair an interrupted turn on the
next process start, but process shutdown is not yet a coordinated runtime
boundary:

- `blade web` and `blade serve` wait on a never-settling Promise, so their
  normal `server.stop()` calls are unreachable;
- the process-wide shutdown manager has no Web server cleanup owner;
- `BladeServer.stop()` stops schedulers and sockets without first closing run
  admission, cancelling active Agent work, or waiting for terminal persistence;
- `Agent.destroy()` disposes tools and MCP resources without owning an
  abort-and-settle barrier for an active `chatStream()`;
- `AcpSession.destroy()` aborts a prompt and immediately destroys its Agent and
  Runtime, so prompt finalization can race resource disposal;
- TUI cleanup relies on `Agent.destroy()`, and therefore has the same race on a
  direct `SIGTERM`;
- `SessionRuntime.dispose()` clears its active-turn mailbox reference before
  resource cleanup and is not a substitute for settling the turn owner.

Headless already aborts its active run and awaits `drainLoop()` before Runtime
disposal. That behavior is the baseline for every surface.

The cold-recovery path prevents permanent transcript loss, but a graceful
shutdown must not routinely depend on the next process start to manufacture
the missing terminal event. It must also reject late work instead of admitting
new turns while shutdown is draining old ones.

## Cross-Runtime Audit

The five audited areas rank as follows:

| Rank | Area | Blade status | Remaining risk |
| --- | --- | --- | --- |
| 1 | shutdown | per-surface cleanup, no shared settle barrier | active turns can race disposal or socket shutdown |
| 2 | tool orchestration | ordered execution and result budgets | read/write concurrency remains unbounded |
| 3 | context | proactive/reactive compaction and checkpoints | no Codex-style typed world-state diff |
| 4 | admission | bounded top-level task queue | tool-level queues need a separate bound |
| 5 | checkpoint | durable turns, inbox, Goal and subagent adoption | shutdown does not consistently reach the terminal checkpoint |

Unbounded tool concurrency is a real follow-up, but it is an independent
admission patch. It is excluded from `0.10.34`.

## Reference Behavior

- Codex exposes `SessionIo.shutdown_and_wait()`, closes request admission before
  waiting for in-flight RPCs, and tests that channel closure aborts an active
  turn before thread-stop lifecycle handlers run.
- Grok Build's Session shutdown cancels the running turn and subagents, drains
  workflows under a fixed budget, flushes pending persistence, removes queued
  synthetic work, then runs Session-end lifecycle.
- Claude Code aborts the active print-mode query on signal, runs critical
  session cleanup before analytics, and retains a process-level failsafe.
- Neovate awaits its server shutdown in the top-level CLI, but its ACP signal
  handlers still exit directly. Blade must preserve its stronger durable
  lifecycle instead of copying that weaker path.

## Scope

This patch covers:

- process-wide `SIGINT`, `SIGTERM`, fatal-error, and normal exit cleanup;
- Agent `chatStream()` admission, cancellation, and settlement;
- Web/serve run, user-shell, review, Runtime, scheduler, and socket shutdown;
- ACP prompt and user-shell shutdown;
- TUI direct-signal shutdown;
- Headless regression coverage;
- Session lease, MCP, LSP, worktree, background shell, and child-process
  cleanup already owned by `SessionRuntime.dispose()`.

This patch does not change:

- JSONL event names or payload schemas;
- cold `process_restart` recovery;
- viewer/SSE ownership;
- Provider retry or stall policy;
- tool concurrency limits;
- compaction policy;
- background task completion semantics;
- ordinary user cancellation UX.

## Invariants

Shutdown follows one ownership order:

```text
close admission
  -> signal active work
  -> await active work settlement
  -> persist the existing terminal turn outcome
  -> dispose Session-owned resources
  -> stop transport and process services
```

The following invariants are mandatory:

1. No turn or shell/review operation starts after its owner enters closing.
2. Every operation admitted before closing either settles normally or observes
   the shutdown AbortSignal.
3. Resource disposal does not race a still-running Agent generator on the
   graceful path.
4. A turn that observes shutdown uses the existing
   `turn_aborted(cause="cancelled")` contract.
5. Durable inbox messages remain unacknowledged after an aborted turn.
6. Closing is idempotent and all concurrent close callers observe one
   completion.
7. Viewer disconnect remains unrelated to Agent shutdown.
8. The process-level failsafe remains the final time bound. If it fires, the
   existing cold-recovery protocol remains authoritative.

## Agent In-Flight Gate

Introduce one Agent-owned gate for `chatStream()` operations.

The gate provides:

```ts
interface ActiveOperationLease {
  signal: AbortSignal;
  release(): void;
}

class ActiveOperationGate {
  enter(externalSignal?: AbortSignal): ActiveOperationLease;
  close(reason?: unknown): void;
  waitForIdle(): Promise<void>;
  shutdown(reason?: unknown): Promise<void>;
  stats(): { accepting: boolean; active: number };
}
```

Contract:

- `enter()` fails after close;
- each lease owns a child AbortController combined with the caller signal;
- `close()` synchronously rejects new work and aborts every active lease;
- `release()` is idempotent and removes all listeners and retained state;
- `waitForIdle()` resolves immediately at zero or after the final active lease
  releases;
- `shutdown()` is idempotent and shares one close-and-wait Promise;
- no timer is owned by the gate.

`Agent.chatStream()` acquires a lease before task admission. The lease signal is
the signal used by admission, Provider streaming, tools, compaction, hooks, and
turn finalization. Its `finally` releases the lease only after the existing
Agent/Session terminal bookkeeping finishes.

`Agent.destroy()`:

1. closes the gate with `agent-destroy`;
2. awaits gate idle;
3. disconnects Agent-owned MCP resources;
4. disposes the ToolExecutor;
5. becomes terminal and rejects future execution.

This makes TUI and ACP cleanup safe without teaching `SessionRuntime` how to
cancel an operation whose AbortController is owned by a surface.

## Web Route Shutdown

The Session route owner exposes an idempotent shutdown handle registered with
`BladeServer`.

It has two phases:

### Close Admission

Set a route-wide closing state before taking any snapshot of active work.

All mutating routes that can create or resume work fail with HTTP `503` while
closing, including:

- message/turn submission;
- task dispatch and retry;
- user shell;
- code review;
- pending-input and Goal auto-resume;
- subagent resume.

Read-only history/status requests may continue until the transport closes.

### Drain

After admission closes:

1. cancel every active Agent run and resolve pending permission waits;
2. abort every active user-shell and review run;
3. await all captured completion Promises;
4. await any Runtime initialization already in flight;
5. dispose every owned Runtime exactly once;
6. disconnect the shared MCP registry when no Runtime remains;
7. clear route-owned schedulers, timers, maps, and listeners.

The drain repeats its snapshot check until no pre-close work remains. This
closes the race where an operation passed route validation immediately before
the closing bit changed but had not yet inserted its completion into a map.

`BladeServer.stop()` performs:

```text
close Session-route admission
  -> close HTTP/WebSocket listeners
  -> drain Session-route work
  -> stop task scheduler and stale-session GC
```

One failed cleanup is recorded, but independent cleanup owners continue.
`stop()` is idempotent and concurrent callers share one Promise.

`blade web` and `blade serve` register `server.stop()` with the global cleanup
registry immediately after listen succeeds. Their unreachable tail calls are
removed.

## ACP Shutdown

`AcpSession` tracks the completion Promise for:

- the current prompt;
- the current user-shell command.

`destroy()`:

1. marks the Session destroyed and prevents pending auto-resume;
2. closes ACP update egress;
3. aborts prompt and user shell;
4. awaits both captured completions;
5. awaits `Agent.destroy()`;
6. disposes `SessionRuntime` and ACP service context.

Calling `destroy()` from the active prompt itself is forbidden; all production
callers own the Session outside that operation. Concurrent destroy calls share
one Promise.

`BladeAgent.destroy()` continues to own all ACP Sessions and waits for each
Session destroy before connection teardown completes.

## Process-Wide Shutdown

The global shutdown manager keeps its existing five-second failsafe and
terminal reset, but critical cleanup runs before logger shutdown.

Ordering:

```text
mark process closing
  -> run registered runtime/server cleanup
  -> run SessionEnd hooks
  -> flush and stop logger
  -> restore terminal
  -> exit
```

Cleanup handlers remain reverse-registration ordered and failure-isolated. The
timeout is cleared after normal cleanup so it cannot retain the process or fire
after completion.

Signal behavior:

- Headless's local signal owner still aborts the active run; global cleanup is
  idempotent around it.
- TUI direct `SIGTERM` reaches Agent gate shutdown through its registered
  cleanup.
- Web/serve reaches `BladeServer.stop()` through its registered cleanup.
- ACP reaches `BladeAgent.destroy()` through connection/process ownership.

Fatal exceptions use the same best-effort ordering. They exit non-zero after
cleanup.

## Durability

No new persistence record is introduced.

The graceful path relies on the existing order inside `Agent.chatStream()`:

```text
AbortSignal observed
  -> loop/tool cancellation result
  -> SessionRuntime.finishTurn()
  -> turn_aborted persisted
  -> active lease released
  -> Agent.destroy() continues
  -> SessionRuntime.dispose() releases lease/resources
```

If the process-level failsafe terminates the process before settlement, the
existing startup repair writes exactly one `turn_aborted(process_restart)` and
repairs interrupted tool calls. A graceful abort and a cold repair cannot both
become terminal for the same turn.

## Deterministic Verification

Tests cover, without sampling:

- gate admission before/after close;
- caller-signal and shutdown-signal propagation with reasons;
- multiple active leases and final-idle settlement;
- idempotent release, close, shutdown, and concurrent waiters;
- no retained AbortSignal listeners after release;
- `Agent.destroy()` waits for an active generator's `finally`;
- no new Agent task admission after destroy begins;
- active tools observe abort before ToolExecutor disposal;
- TUI cleanup produces one durable abort before Runtime disposal;
- ACP destroy waits for prompt and user-shell completion;
- Web close rejects every work-creating route;
- Web drains Agent, shell, review, Runtime initialization, and Runtime disposal;
- a route-admission race cannot escape the drain;
- Web server stop ordering and concurrent idempotence;
- Session lease release happens after turn terminal persistence;
- shutdown cleanup failures do not skip independent owners;
- logger shutdown occurs after critical runtime cleanup;
- process failsafe remains armed only while shutdown is incomplete;
- Headless signal behavior and output drain remain unchanged;
- no duplicate `turn_aborted`, inbox acknowledgement, task permit release, or
  SessionEnd hook.

Tests use controlled barriers and explicit event ordering. They do not assert
absolute execution duration.

## Real API Qualification

Release-blocking qualification uses DeepSeek Flash and Pro across:

- Headless child process;
- real ACP SDK transport;
- raw PTY TUI;
- production Chromium Web GUI.

Each cell starts a real Provider turn that launches a real foreground process,
waits for host-visible proof that the turn and process are active, then sends
the surface's production shutdown signal.

After restart/resume, each cell proves:

- no new work was admitted after shutdown began;
- the active Provider/tool path observed cancellation;
- exactly one terminal record exists for the interrupted turn;
- durable input remains resumable and is not duplicated;
- foreground and descendant processes are gone;
- a delayed forbidden side effect did not occur;
- Session, task-admission, worktree, MCP, LSP, browser, PTY, port, and transport
  resources are reclaimed;
- no Provider credential appears in JSONL, logs, ACP traffic, PTY capture, or
  browser DOM;
- a subsequent turn in the same Session succeeds.

The Web cell additionally verifies that closing a viewer alone still does not
cancel the server-owned run, while process/server shutdown does.

## Release Boundary

`0.10.34` is complete only when:

- deterministic production qualification passes;
- the Flash/Pro four-surface matrix passes with real Provider calls;
- production Chromium and raw PTY shutdown trajectories pass;
- npm package version, changelog, docs, tag, registry artifact, and GitHub
  Release agree;
- the feature worktree and branch are reclaimed after merge.

