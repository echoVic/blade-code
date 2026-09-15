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

## MCP Catalog Waits

Main loops and side questions wait for MCP catalog refresh before entering the Provider. Cancellation ends only the current waiter, not the refresh shared with other tasks. Success, failure, and cancellation remove the waiter's signal listener; a refresh failure arriving after cancellation is still observed rather than becoming an unhandled rejection.

Side questions check cancellation before preparation and after context preparation, so cancelled requests do not reach the Provider. Context file reads still settle before Runtime ownership is released. This does not promise interruption of arbitrary blocked filesystem calls or Runtime initialization. During server shutdown, catalog waiters exit before the Session-owned MCP transport is disconnected in the existing cleanup order.

Side context and system-prompt preparation run concurrently. If either fails, the first error is preserved while all already-started preparation settles before the executor and Session lease are released. Failed requests do not reach the Provider. Chromium verification combines a damaged context record with a held FIFO memory read, checks that the error waits for the read, and verifies a subsequent question after recovery. The FIFO scenario runs only on systems supporting named pipes; deterministic tests cover either failure source and a late sibling failure.

## TUI and Headless

TUI process-level shutdown first synchronously calls the active command's abort controller, then performs React/Agent cleanup. This way, even if the terminal host begins UI unload after the signal, the Agent generator can still first submit the terminal turn record.

When `/btw` runs alongside a main task, the first `Esc` cancels only the side question. After the panel closes, the next `Esc` can stop the main task. Duplicate cancellation is scoped to the current target rather than the entire busy period, and replacing a side request also re-arms cancellation. Real DeepSeek Flash/Pro raw-PTY tests verify the main abort record, tool-process cleanup, and subsequent side questions; raw PTY is not desktop Computer Use.

Headless continues to be controlled by the invocation-local signal owner: after receiving `SIGINT` or `SIGTERM`, it cancels the current turn, waits for output drain and Runtime disposal, then returns with interrupted status. Headless does not depend on process-level UI cleanup.

## Web and serve

`blade web` and `blade serve` register server cleanup immediately after successful listen. After shutdown begins:

- messages, side questions, task dispatch/retry/delivery, user shell, code review, and durable resume no longer accept new work;
- HTTP mutations return `503 SERVICE_UNAVAILABLE`;
- Active Agent runs, side questions, user shells, and reviews receive abort;
- Runtime is released only after all observed completion Promises have settled;
- Session route owner is cleared only after Runtime initialization, Runtime disposal, and shared MCP cleanup all complete;
- Task scheduler, stale-session GC, and network listeners stop last.

Closing only the browser tab, SSE viewer, or other subscriber does not trigger this flow. Viewer ownership continues to be separated from server-owned Agent runs; only server/process shutdown closes run admission.

Web side conversations (`/btw`) are request-owned: dismissing the panel or disconnecting the request cancels that question. Server shutdown also signals cancellation immediately instead of waiting for the side request before releasing its Runtime. A question already initializing its Runtime receives cancellation after initialization; new questions during shutdown return `503`. Settled requests remove their client cancellation listeners, so later questions remain independent. Side conversations neither create a main run nor modify the main session JSONL. Main runs remain server-owned and do not stop when a side question is cancelled or their submitting request disconnects.

## ACP

`AcpSession.destroy()` simultaneously holds both prompt and user-shell completion barriers:

1. Mark Session closing and close update egress;
2. Abort prompt and user shell;
3. Wait for both to complete final ACP/Runtime bookkeeping;
4. Wait for `Agent.destroy()`;
5. Release SessionRuntime and ACP service context.

Concurrent destroy calls on the same Session or BladeAgent share a single Promise. Natural stdio ACP connection close, host signals, and process cleanup all ultimately enter the same BladeAgent owner.

Shutdown writes keyboard, cursor, and style reset sequences only when stdout is a TTY. Pipes and files receive no ANSI reset bytes, preserving ACP JSON framing. Stdin raw-mode restoration remains independent, with unchanged cleanup ordering and budgets.

ACP `session/cancel` also cancels a side question waiting for the MCP catalog and returns `stopReason="cancelled"`. Separate stdio tests verify that Flash/Pro can answer a subsequent `/btw`, with exact display text and unchanged main JSONL.

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

The main-run shutdown trajectory uses real DeepSeek Flash/Pro, sends production `SIGTERM` while a real foreground Bash is active, and verifies durable abort, turn recovery, resource reclamation, delayed side effects, and credential absence. The current release matrix runs six cells across Headless, real ACP stdio, and production Chromium. Raw PTY TUI is excluded from that gate and requires separate verification; it is not native desktop Computer Use.

Side conversations have a separate four-cell Chromium matrix: DeepSeek Flash/Pro × panel dismissal and server `SIGTERM`. Tests receive real Provider content before pausing delivery, then require cancellation within three seconds. Server shutdown must emit the normal stopped log; exit code zero alone is insufficient. A subsequent question must return the exact expected answer, with unchanged main JSONL bytes and no framework or model retries. The separate main-run activity trajectory checks continued execution after browser reload.

MCP catalog cancellation has six additional Chromium cells: DeepSeek Flash/Pro × panel dismissal, server shutdown, and stopping the main turn. A real stdio MCP transport holds catalog refresh while each waiter must settle within three seconds without a Provider request from the cancelled operation. Dismissal and main-turn stop leave shared MCP alive; releasing refresh permits a subsequent real question. Server shutdown verifies MCP process reclamation, and the main turn must commit exactly one aborted terminal record.
