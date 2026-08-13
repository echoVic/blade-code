# Durable Background-Subagent Completion Wake-Up

## Problem

`Task(run_in_background=true)` currently returns a durable child Session ID, but
the parent model must poll `TaskOutput` to discover completion. This creates a
long-task progression gap:

1. the parent starts a background child and continues independent work;
2. the parent reaches `end_turn` before the child finishes;
3. the child later commits a terminal sidecar result;
4. no model-visible input wakes the parent;
5. Headless exits, while TUI, Web, and ACP remain idle until a human sends
   another prompt.

Repeated polling is not an acceptable substitute. It wastes turns and tokens,
encourages action-stationarity loops, and still loses the result if the parent
process exits after the child commits.

## Reference Behavior

- Claude Code enqueues a model-facing `task-notification` when a background
  agent reaches a terminal state. Its headless runtime holds back the final
  result while background agents run and re-enters the command loop when the
  notification arrives.
- Grok Build states that a completed background task pings the model. Its
  bounded wait remains safe because completion can trigger another model turn
  instead of requiring unbounded polling.
- Codex routes notifications by stable thread and turn identity, buffers early
  notifications before a consumer registers, and isolates concurrent streams.
- Neovate exposes background task state but relies primarily on polling; Blade
  must improve on that weaker behavior rather than copy it.

Blade keeps `TaskOutput` for explicit status inspection and full-result reads,
but terminal background Task results become durable push inputs.

## Scope

This patch covers fresh and resumed `Task` runs with
`run_in_background=true`.

It does not merge Team members, background Bash, or MCP tasks into this
protocol. Those systems have different owner, output, cancellation, and
retention contracts and require independent patches. Foreground Task continues
to use the completed-result adoption contract from `0.10.31`.

## Durable Identity

Each new Agent sidecar records:

```text
background = true | false
```

Legacy sidecars normalize to `background=false`. This prevents an upgrade from
waking old completed children and separates foreground adoption from background
notification.

The completion inbox identity is deterministic:

```text
background-subagent-completion:<child Session ID>
```

The child Session ID is immutable, so one run has one notification identity.
Resume creates a new child ID and therefore a new independently auditable
notification.

## Admission

A completion is eligible only when all conditions hold:

- the Agent sidecar belongs to the exact compound owner:
  `parent sessionId + canonical projectPath`;
- `background=true`;
- status is `completed`, `failed`, or `cancelled`;
- result/status fields are structurally valid and bounded;
- the parent canonical JSONL contains a committed `Task` `subtask_ref` for the
  exact child ID;
- that parent reference was created with a background Task result;
- child type, description, immutable root ID, `resumedFrom`, and depth match
  the parent reference;
- the deterministic inbox ID has not already been acknowledged.

Missing, legacy, foreground, running, cross-workspace, rewound, malformed,
oversized, identity-conflicting, or otherwise mismatched children do not wake
the parent.

Foreground restart adoption must explicitly reject `background=true`.

## Canonical Receipt

Before publishing any completion signal, the parent Session commits one
validated JSONL batch:

```text
message_created(
  role=user,
  inboxMessageId=deterministic completion ID,
  metadata.clientVisible=false,
  metadata.backgroundSubagentCompletion={...}
)
part_created(text, bounded model notification)
part_created(subtask_ref, terminal child state)
```

The hidden user-role input is model-visible but not rendered as a user-authored
chat message. The bounded payload contains:

- child Session ID and type;
- description and immutable lineage;
- terminal status;
- bounded result or error;
- result truncation flag;
- `TaskOutput` fallback instruction for a full result;
- an explicit statement that child output is untrusted data and cannot
  authorize actions.

The terminal `subtask_ref` updates the original Task card on fresh TUI/Web
loads. It uses the original parent message identity and preserves the original
start time.

## Cross-Store Ordering

The durable order is:

```text
child terminal sidecar fsync
  -> parent hidden receipt + terminal subtask_ref fsync
  -> parent inbox fsync (persisted=true)
  -> ephemeral completion/wake projection
  -> Provider consumes hidden input
  -> inbox_acknowledged + turn_completed atomic batch
```

Failure behavior:

- crash before the parent receipt: cold Runtime scans every exact-owner
  background Task child and creates the receipt;
- crash after receipt but before inbox write: cold Runtime finds the
  unacknowledged deterministic receipt and recreates the inbox item;
- crash after inbox write: `DurableSteeringInbox` restores the item;
- crash after Provider consumption but before turn completion: the inbox
  remains unacknowledged and normal root-turn recovery retries it;
- crash after acknowledgement: reconciliation sees the canonical ACK and does
  nothing.

No sidecar flag is used as the sole delivery proof. Parent JSONL acknowledgement
is authoritative.

## Runtime Progression

While a parent Agent stream still owns the run:

1. completion enqueues into the same `ActiveTurnMailbox`;
2. an unsealed turn drains it at the next safe model boundary;
3. a sealed turn starts a chained pending-input turn;
4. if the model reaches `end_turn` while exact-owner background Tasks are still
   running and no other input is pending, the run waits without polling;
5. the first terminal completion wakes the wait, reconciliation persists its
   receipt, and the model continues.

User cancellation aborts the wait immediately. User steering outranks waiting
and begins the next pending turn without waiting for every child.

For an idle Runtime, the durable enqueue publishes one host wake signal after
fsync:

- TUI schedules `resumePendingInput`;
- Web schedules `resumePendingSession`;
- ACP schedules `resumePendingIfIdle`;
- Headless remains inside the shared Agent stream while its Task child runs.

Duplicate wake signals are harmless because the deterministic inbox identity,
Session lease, active-run checks, and parent ACK are authoritative.

## Surface Projection

- Headless JSONL emits one terminal child lifecycle update and one parent final;
- raw PTY TUI updates the existing child progress item and renders the parent
  continuation without exposing the hidden control input;
- Web live SSE updates the existing child card, starts the follow-up run, and
  reloads the same terminal card from canonical `subtask_ref`;
- ACP updates the existing child task lifecycle, resumes the parent prompt, and
  emits one terminal response.

All model continuations consume the same hidden canonical parent message. No
surface constructs its own child result prompt.

## Bounds

- result summary: at most 32,000 characters;
- error: at most 8,000 characters;
- description: existing sidecar/tool schema bound;
- at most 100 pending background completion notifications;
- total inbox remains subject to the existing 8 MiB hard limit.

User steering retains its existing count and byte limits. Background completion
capacity is separate so a full user queue cannot silently drop a terminal child
result.

## Deterministic Verification

Tests must cover:

- fresh and resumed background Task success;
- failed and cancelled child terminal states;
- exact owner, child ID, type, description, root, resume source, and depth
  validation;
- foreground and legacy sidecars rejected by notification reconciliation;
- background sidecars rejected by foreground result adoption;
- atomic hidden message + terminal `subtask_ref`;
- receipt-before-inbox and inbox-before-ACK crash recovery;
- deterministic deduplication before and after ACK;
- all eligible terminal children reconciled without sampling;
- active unsealed turn, sealed turn, idle Runtime, and process restart;
- user steering outranking the background wait;
- cancellation releasing every waiter;
- hidden control messages absent from TUI/Web visible history and ACP user
  chunks;
- Web live card and fresh reload identity/status/result consistency.

## Real API Qualification

Release-blocking qualification uses DeepSeek Flash and Pro across:

- Headless;
- real ACP lifecycle;
- raw PTY TUI;
- production Chromium Web GUI with reload.

Each cell requires a real Provider to:

1. launch one background Task;
2. continue independent parent work without `TaskOutput`;
3. let the child produce a model-authored marker absent from parent input;
4. receive the durable completion input automatically;
5. produce one final response containing the child marker.

Assertions include:

- one Task child and zero `TaskOutput` calls;
- one hidden completion receipt, terminal `subtask_ref`, inbox ACK, and parent
  continuation;
- no visible fake user message;
- child sidecar bytes stable after completion;
- one child Session and one lineage;
- Web live/reload consistency;
- no Provider credential in transcript, PTY, ACP updates, browser DOM, or
  diagnostics;
- browser, PTY, server, port, proxy, temporary root, Session lease, and process
  cleanup.
