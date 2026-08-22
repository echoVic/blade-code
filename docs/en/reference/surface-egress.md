# Surface Output Backpressure and Ordering

Blade Code manages canonical Runtime state separately from user interface transports. JSONL commits, Session leases, and Agent runs are held by the Runtime; Headless, Web SSE, and ACP are only responsible for projecting already-generated events to consumers in a bounded, ordered manner. A slow or disconnected viewer cannot reversely cancel a server-owned run, nor can it cause unbounded memory or latency growth for other consumers.

## Shared Queue Contract

Each transport uses a single-writer FIFO, simultaneously limiting entry count and UTF-8 byte count:

- At most 256 pending items;
- At most 8 MiB pending bytes;
- Active writes and not-yet-started items both count against capacity;
- A single write waits at most 30 seconds;
- `flush()` waits for the high-water sequence accepted at call time, not for subsequent new events;
- Overflow, oversized items, timeout, abort, closed writer, and writer rejection all fail closed.

Ordinary events are not silently dropped to maintain connections. Capacity exhaustion represents transport failure: close the corresponding subscriber or surface turn, and preserve canonical Session facts for subsequent reload/resume. Heartbeats are sent only when Web egress is idle and do not consume ordinary event capacity.

## Web SSE

Session streams use the following atomic initialization order:

1. First subscribe to the live Bus, and buffer events during initialization in a bounded buffer;
2. Write the connected frame;
3. Serially replay JSONL by committed `seq`;
4. Remove live duplicates already covered by replay, sort remaining committed events by `seq`;
5. Switch to live mode and reject subsequent sequence regression.

`Last-Event-ID` uses only durable committed sequences as authoritative. Ephemeral deltas do not participate in the resume cursor; old deltas in the replay window are discarded. Subscriber overflow or write timeout evicts only that subscriber; the Session's server-owned Agent run and other fast subscribers continue running.

The Web Store opens and buffers EventSource before fetching history, atomically commits and replays buffered events after the snapshot is ready, avoiding gaps between snapshot/subscribe. The final `session.completed`, `session.error`, or `run.cancelled` triggers one merged authoritative message resync; only durable lifecycle markers do not repeatedly replace DOM.

## ACP

An `AcpSession` has only one underlying `connection.sessionUpdate()` write path. content, thinking, tool updates, slash commands, user-shell, and metadata all enter the same FIFO:

- At most one update in-flight at any time;
- The Agent generator waits for queue flush after each LoopEvent;
- Prompts, slash commands, and user-shell return only after the final update is written;
- Timeout, overflow, or connection abort cancels current work and does not continue producing updates;
- Transport failure does not forge recovery input via fake `user_message_chunk`.

## Headless

stdout and stderr each have independent FIFOs and capacities. When a Node writable returns `false`, Headless waits for `drain` while simultaneously listening for `error` and the turn `AbortSignal`; writers with no observable drain contract fail closed immediately.

Each Agent LoopEvent, user-shell output boundary, warning/error, and terminal phase flush before continuing or returning. `EPIPE`, closed writer, write timeout, or abort terminates the current turn, clears drain/error/abort listeners, and causes `runHeadless()` to return failure.

## TUI

TUI's local React/Ink projection does not go through remote egress queues, so slow Web viewers or ACP IDEs do not hold back local rendering. Real raw PTY qualification tests pause the host reader, then resume consumption and verify that final output continues rendering; this test verifies terminal pipe behavior and does not treat PTY reader pause as Agent backpressure.

## Verification Boundaries

Deterministic tests cover FIFO, UTF-8 accounting, active-write capacity, flush high-water, timeout/abort, Web replay/live cutover, slow subscriber isolation, ACP single in-flight, and Headless drain/EPIPE. Release-blocking real API further runs an eight-cell matrix of DeepSeek Flash/Pro × Headless, raw PTY TUI, production Chromium Web GUI, and real ACP.
