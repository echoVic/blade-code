# Runtime Coordinated Shutdown

Blade Code treats the shutdown process as a Runtime ownership boundary rather than directly terminating the process. TUI, Web, Headless, and ACP all follow the same order:

```text
Close new work entry
  -> Abort active work
  -> Wait for terminal persistence
  -> Release Session resources
  -> Stop transports and process services
```

## Agent Barrier

Each Agent holds an active-operation gate. `chatStream()` obtains a lease before task admission and passes the combined `AbortSignal` to Provider streaming, tools, compaction, hooks, and turn finalization.

`Agent.destroy()` performs the following steps:

1. Synchronously reject new Agent operations;
2. Abort all active leases with `agent-destroy`;
3. Wait for generator `finally` and existing `SessionRuntime.finishTurn()` to complete;
4. Disconnect Agent-owned MCP;
5. Release ToolExecutor.

Normal shutdown reuses the existing `turn_aborted(cause="cancelled")` and does not add new JSONL events. The durable inbox remains recoverable after an aborted turn; subsequent `--resume`, TUI, Web, or ACP `session/load` can continue the original input.

## TUI and Headless

TUI process-level shutdown first synchronously calls the active command's abort controller, then performs React/Agent cleanup. This way, even if the terminal host begins UI unload after the signal, the Agent generator can still first submit the terminal turn record.

Headless continues to be controlled by the invocation-local signal owner: after receiving `SIGINT` or `SIGTERM`, it cancels the current turn, waits for output drain and Runtime disposal, then returns with interrupted status. Headless does not depend on process-level UI cleanup.

## Web and serve

`blade web` and `blade serve` register server cleanup immediately after successful listen. After shutdown begins:

- messages, task dispatch/retry/delivery, user shell, code review, and durable resume no longer accept new work;
- HTTP mutations return `503 SERVICE_UNAVAILABLE`;
- Active Agent runs, user shells, and reviews receive abort;
- Runtime is released only after all observed completion Promises have settled;
- Session route owner is cleared only after Runtime initialization, Runtime disposal, and shared MCP cleanup all complete;
- Task scheduler, stale-session GC, and network listeners stop last.

Closing only the browser tab, SSE viewer, or other subscriber does not trigger this flow. Viewer ownership continues to be separated from server-owned Agent runs; only server/process shutdown closes run admission.

## ACP

`AcpSession.destroy()` simultaneously holds both prompt and user-shell completion barriers:

1. Mark Session closing and close update egress;
2. Abort prompt and user shell;
3. Wait for both to complete final ACP/Runtime bookkeeping;
4. Wait for `Agent.destroy()`;
5. Release SessionRuntime and ACP service context.

Concurrent destroy calls on the same Session or BladeAgent share a single Promise. Natural stdio ACP connection close, host signals, and process cleanup all ultimately enter the same BladeAgent owner.

## Bounded Failure

Process-level graceful shutdown is covered by a 5-second hard failsafe. The normal path executes in the following order:

```text
active command abort
  -> registered Runtime/server cleanup
  -> SessionEnd hooks
  -> logger shutdown
  -> terminal restore
  -> process exit
```

The Runtime cleanup phase uses an independent 4-second budget; after success, hard/phase timers are cleared. If the Provider, tools, or host transport cannot settle within budget, the process is terminated by the hard failsafe, and the existing `process_restart` cold recovery protocol continues as the final authority. Graceful abort and cold recovery must not produce two terminal records for the same turn.

## Verification Boundaries

Deterministic tests cover operation admission, abort reason, idle barrier, concurrent destroy, ACP prompt/user-shell settlement, Web closing `503`, run completion and Runtime dispose order, cleanup failure isolation, logger order, and timer cleanup.

Release-blocking real API consistently runs an eight-cell matrix of DeepSeek Flash/Pro × Headless, real ACP stdio, raw PTY TUI, and production Chromium Web GUI. Each cell sends production `SIGTERM` while a real foreground Bash is active, and verifies durable abort, turn recovery, process tree/lease/port/transport reclamation, delayed side-effect controls, and Provider credential absence.
