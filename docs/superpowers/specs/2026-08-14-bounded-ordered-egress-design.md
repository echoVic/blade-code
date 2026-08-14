# Bounded Ordered Surface Egress

Target: `blade-code@0.10.33`

## Problem

Blade's Agent runtime is durable, but several output transports are not
production-bounded:

- Web Session SSE calls `writeSSE()` from synchronous Bus callbacks without
  awaiting the previous write;
- Web reconnect replay also starts `writeSSE()` calls without awaiting them, so
  replayed committed events can race live events and regress the event cursor;
- ACP `sendUpdate()` explicitly starts `sessionUpdate()` without waiting, so a
  slow IDE can create an unbounded set of promises and reorder updates;
- Headless ignores `Writable.write(false)`, so a slow pipe can continue
  accepting Agent events into Node's internal stream buffer.

A client that stops reading must not consume unbounded memory, reorder
canonical lifecycle events, or cancel an unrelated server-owned Web turn.
Transport speed must also not change the durable Session transcript.

## Reference Behavior

- Claude Code separates a remote Session from its WebSocket subscriber. Its
  subscriber has bounded reconnect attempts, distinguishes transient and
  permanent closes, and viewer disconnect does not imply an Agent interrupt.
- Codex app-server routes notifications through a bounded `mpsc::Sender`, awaits
  channel admission, tracks connections separately from thread state, and can
  replay pending requests to a replacement connection.
- Grok Build uses bounded outbound channels, non-blocking routing so one slow
  consumer cannot starve other sessions, explicit slow-consumer eviction, and
  reconnect sequence identities for deduplication.
- Neovate has a fixed message buffer and reconnect backoff, but its server
  creates per-connection bridges and does not provide Blade's durable committed
  sequence contract. Blade must keep its stronger Session ownership model.

Blade will use the canonical JSONL sequence as the recovery authority instead
of retaining an unbounded transport backlog.

## Scope

This patch covers Agent-facing output from:

- per-Session Web SSE;
- global Web task/session SSE;
- ACP `sessionUpdate`;
- Headless stdout and stderr.

TUI has no remote subscriber queue. It keeps its current Zustand/Ink projection
and is included in regression and raw PTY qualification.

This patch does not change:

- Provider stream input or watchdog semantics;
- durable Session event schemas;
- Web terminal-panel WebSocket ownership;
- MCP transport queues;
- background shell retained-output limits;
- model-visible content or tool-result projection.

Those systems have independent ownership and retention contracts.

## Shared Primitive

Introduce one `BoundedSerialEgress<T>` primitive with:

```text
max pending items = 256
max pending UTF-8 bytes = 8 MiB
write timeout = 30 seconds
```

The limits include the active write and every queued value. A single value
larger than the byte limit is rejected before it is retained.

The primitive provides:

- synchronous admission result from `offer(value)`;
- a completion promise for each accepted value;
- exactly one active writer call;
- FIFO delivery;
- UTF-8 byte accounting supplied by the caller;
- `flush()` for all values accepted before the call;
- idempotent `close(reason)`;
- one terminal failure callback;
- prompt settlement of queued completion promises after close;
- internal observation of every completion so ignored promises cannot become
  unhandled rejections;
- timeout and AbortSignal cleanup with no retained listeners or timers.

There is no unbounded promise chain. Queue storage is the only pending storage.
Closing cannot cancel an arbitrary underlying JavaScript promise, but the queue
releases its value, observes any late rejection, and ignores late settlement.

Ordinary events are never silently dropped or reordered. Overflow is a
transport failure with surface-specific handling.

## Web Session SSE

### Ownership

The existing `RunState` and `SessionRuntime` remain independent of an SSE
subscriber. Aborting, timing out, or overflowing one subscriber:

- unsubscribes only that Bus callback;
- closes only that SSE response;
- does not call `cancelRun`;
- does not abort the Session Runtime;
- does not affect another tab's subscriber.

The browser reconnects using its last successfully delivered committed
sequence.

### Serialization

Each SSE frame is serialized before queue admission. Its retained byte count is
the exact UTF-8 size of the serialized frame data plus its bounded SSE metadata.

All writes, including:

- `connected`;
- committed events;
- ephemeral events;
- pending-interaction replay;
- heartbeats;

flow through one serial egress writer.

A heartbeat is skipped when another frame is pending. Heartbeats never cause an
otherwise healthy subscriber to overflow.

### Replay/Live Cutover

Connecting with `Last-Event-ID=N` follows this order:

```text
register Bus listener in buffering phase
  -> write connected
  -> replay canonical committed events from N+1 sequentially
  -> record highest replayed seq
  -> discard buffered ephemeral events from the replay window
  -> drop buffered committed duplicates with seq <= highest replayed seq
  -> enqueue remaining buffered committed events in ascending seq order
  -> atomically switch listener to live mode
```

Bus registration happens before the transcript read so no commit can fall into
the read/subscribe gap. The buffering-to-live transition is synchronous, so a
Bus callback cannot land between the final buffer drain and the phase switch.

Committed sequence numbers must be strictly monotonic at this subscriber.
Sequence gaps are allowed because hidden/non-projected JSONL events may consume
sequence numbers. A duplicate or regressing sequence is ignored only when it is
already covered by replay; any other regression closes the subscriber.

A fresh connection without a cursor writes `connected`, then preserves all
events buffered during initialization in observation order.

`SessionEventLog.replay()` awaits an asynchronous replay callback. Live fan-out
remains synchronous and never waits for a surface.

### Slow Consumer

If count, byte, or write-time limits are reached:

1. stop accepting frames;
2. unsubscribe immediately;
3. close/abort the Hono stream;
4. release all timers, buffered frames, and completion waiters;
5. log only surface, reason, pending count, and pending bytes.

No payload, credential, tool result, or user content is written to diagnostics.

Global task/session SSE uses the same serial primitive and failure cleanup but
has no transcript replay phase.

## ACP

Every `connection.sessionUpdate()` call is routed through one Session-scoped
`BoundedSerialEgress`.

Agent loop handling performs:

```text
project one LoopEvent
  -> enqueue all updates caused by that event
  -> flush accepted updates
  -> request the next LoopEvent
```

This uses `drainLoop`'s existing async callback and applies real backpressure to
Provider output. Tool start, progress, result, assistant content, thinking,
Goal, compaction, MCP, subagent, and structured-output updates therefore remain
FIFO with at most one `sessionUpdate()` call in flight.

Bus-originated task/background-completion updates use non-blocking admission but
share the same queue and bounds.

Before an ACP prompt returns its final `PromptResponse`, it flushes all updates
accepted by that prompt. A transport failure or timeout:

- closes the egress queue;
- aborts the active prompt with reason `acp-egress-failed`;
- lets normal turn-abort persistence run;
- prevents further updates on the failed connection;
- does not create a fake user message.

Connection abort and `AcpSession.destroy()` close the queue without waiting for
a stuck writer. Pending promises and listeners are settled exactly once.

History replay and recovered Goal/interaction projection use the same queue;
there is no second direct `sessionUpdate()` path.

## Headless

Headless owns one serial egress queue for stdout and one for stderr. Every
`eventWriter` method enqueues bytes through those queues.

For a Node writable:

```text
writer.write(chunk) === true
  -> write complete

writer.write(chunk) === false
  -> await drain or abort
```

The Agent loop flushes both writers after each LoopEvent. User-shell streaming,
task-admission events, recovered-final output, warnings, errors, and terminal
phase output flush before `runHeadless()` returns.

If a writer returns `false` but exposes no observable `drain` contract, the
egress fails closed instead of continuing to buffer. Abort removes `drain` and
`error` listeners. An `EPIPE` or closed writer aborts the attached Headless run
through the existing signal/turn lifecycle.

Text and JSONL schemas do not change.

## TUI

TUI continues to consume LoopEvents directly into the local store. It does not
share a remote transport queue and must not be stalled or cancelled by Web or
ACP subscribers.

Raw PTY tests still verify:

- terminal rendering remains bounded;
- temporary reader backpressure does not duplicate a turn;
- cancellation and process cleanup remain deterministic.

## Durability and Recovery

Egress state is never persisted. JSONL remains the only durable authority.

- a committed event is fsynced before any surface can observe it;
- Web cursor advancement is based only on successfully written committed
  frames;
- Web reconnect reconstructs missed state from JSONL;
- ephemeral deltas are best-effort and are intentionally not replayed;
- ACP/Headless transport failure aborts the attached turn, leaving the existing
  durable root-turn recovery protocol authoritative;
- no surface queue can manufacture a committed event or acknowledge durable
  input.

## Deterministic Verification

Tests cover, without sampling:

- FIFO writes with one writer call in flight;
- exact item and UTF-8 byte boundaries;
- oversized single-frame rejection;
- count overflow and byte overflow;
- write rejection, timeout, AbortSignal, and idempotent close;
- `flush()` high-water semantics while later values continue;
- no timers, listeners, values, or unresolved promises after close;
- two independent subscribers where only the slow one is evicted;
- Web `connected` before live events;
- replay/live race with commits before read, during replay, and at cutover;
- committed duplicate removal and monotonic sequence delivery;
- replay-window ephemeral discard;
- fresh-connect initialization buffering;
- heartbeat suppression while busy;
- SSE write failure/overflow not cancelling `RunState`;
- asynchronous `SessionEventLog.replay()` ordering;
- ACP max in-flight update count of one across every LoopEvent kind;
- ACP Bus updates sharing the same bound;
- ACP prompt response after egress flush;
- ACP timeout/overflow producing one durable abort and no fake input;
- Headless `write(false)` waiting for `drain`;
- Headless stdout/stderr independent bounds and abort cleanup;
- existing output schemas and client projections unchanged.

A repository search gate rejects direct Agent-facing `writeSSE()`,
`connection.sessionUpdate()`, and Headless writer calls outside the approved
egress adapters.

## Real API Qualification

Release-blocking qualification uses DeepSeek Flash and Pro across:

- Headless with an injected slow writable;
- real ACP with delayed `sessionUpdate()` completion;
- raw PTY TUI with a temporarily paused reader;
- production Chromium Web GUI with SSE disconnect/reconnect and reload.

Each cell performs one real Provider coding trajectory with a marker absent from
the prompt and proves:

- one Provider turn lineage and no duplicate tool side effect;
- output ordering remains canonical;
- no surface has more than one transport write in flight;
- pending item and byte high-water marks stay within the frozen limits;
- Headless and ACP apply backpressure instead of accumulating promises;
- Web disconnect leaves the server-owned run active;
- Web reconnect consumes committed events in strictly increasing sequence order;
- Web fresh reload shows the same final assistant/tool state;
- TUI resumes rendering after PTY reads continue;
- no fake user message or transport payload leak;
- Provider credentials are absent from JSONL, ACP updates, PTY capture, browser
  DOM, and diagnostics;
- browser, PTY, server, port, proxy, Session lease, timers, listeners, and
  process resources are reclaimed.
