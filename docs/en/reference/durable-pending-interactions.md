# Durable Pending Interaction Recovery

Blade treats user interactions during tool execution as durable state in Session JSONL, not merely held in CLI/Web/ACP process memory. After process exit, Web server restart, or ACP `session/load`, unanswered requests can still be recovered.

## Coverage

The following interactions enter the same recovery protocol:

- Ordinary tool permission confirmations;
- `AskUserQuestion` structured questions;
- MCP Elicitation;
- MCP Sampling single-shot authorization.

Plan entry/exit and maximum turn prompts are runtime controls and do not use this protocol.

## Write Order

Each interaction uses three monotonic JSONL events:

1. `interaction_requested`: `fsync` before any UI, ACP reverse request, or SSE event becomes visible;
2. `interaction_responded`: `fsync` before the original tool Promise unblocks;
3. `interaction_recovered`: committed after crash recovery closes the original tool call and writes the user decision to the durable inbox.

`interaction_requested` binds to the persisted `toolCallId`. If the tool call itself cannot be persisted, the interaction is not shown. Requests or responses exceeding 128 KiB also fail closed.

MCP Elicitation responses only persist the `accept` / `decline` / `cancel` action, not form content. When sensitive fields are needed after a crash, the MCP server must reissue the request.

## Restart Semantics

### Unanswered Requests

- TUI resume reopens the original confirmation/question;
- Web catalog restores the `pendingInteraction` type and request-ID summary;
  Session SSE replays the complete original question card;
- ACP `session/load` resends the standard permission request before creating Runtime;
- headless/print with no interactive entry point explicitly rejects the request.

Answers are persisted first, then pending state is cleared.

### Answered but Tool Not Finished

Blade does not replay original tool calls that may already have produced side effects. Recovery flow:

1. Write a close result with `interactionRecovery` provenance for the original `toolCallId`;
2. Write user answer or approval decision to Session durable inbox;
3. New Runtime continues with a pending-only turn, letting the model inspect current state before deciding next steps;
4. `interaction_recovered` records recovery completion.

Ordinary permission approvals are not implicitly expanded to Session or project permissions after crashes. If the model still needs to perform the original operation, it must reinitiate based on the current workspace.

## Pending-resume Recovery Boundary

When an eligible Web, ACP, or TUI turn hits a retryable zero-output Provider failure,
all three surfaces use the same pure retry decision. This is distinct from model
transport retries for one physical request, which remain owned by
`PiAIChatService`. Web enables this policy only for non-task-isolated pending-input
turns and starts a new run after the preceding run has durably settled and released
its Agent/Runtime lease. ACP projects the same lifecycle and hard deadline for
pending-input, Goal, and preflight continuations; it waits for the preceding prompt
to settle, then calls prompt again on the same Session-owned Agent/Runtime. TUI keeps
attempt, deadline, backoff-timer, and wake ownership in the mounted
`PendingResumeCoordinator`, without adding a public SSE/ACP retry payload. Automatic
outer retry after failure applies only to pending input and to ACP preflight before the
work kind is known. A Goal failure is not reactivated.

Outer recovery permits at most four total attempts within a 120-second absolute
budget. Base backoff starts at one second, grows exponentially to four seconds,
and adds ±20% stable jitter derived from Session identity and attempt; the final
delay remains capped at four seconds. Another attempt is scheduled only when all
of these conditions hold:

- the surface still has eligible durable work: a durable inbox for Web/TUI; for ACP,
  pending input or preflight before the work kind is known;
- the failure is a canonical retryable `SessionTaskFailure`;
- no non-empty assistant content/thinking or structured output started;
- no tool lifecycle event started and the tool-call count is exactly zero;
- both the attempt budget and the 120-second deadline have remaining capacity.

Missing, malformed, or contradictory replay evidence fails closed. Once output
or tool execution starts, Blade does not replay the whole pending turn, which
prevents duplicate `Write`, shell, network, or other side effects. Attempt or
time exhaustion becomes `exhausted`; non-retryable failures become `failed`.

Recovery state contains only bounded fields and never persists raw Provider
errors, request bodies, paths, headers, or credentials. Web SSE uses
`pending.resume`; ACP uses `session_info_update._meta["blade/pendingResume"]`.
The recovery payload exposes only phase, kind, attempt, maxAttempts, optional
delay/nextRetryAt, and canonical failure code/retryable plus optional resource.
The enclosing SSE or ACP message still carries its normal Session identity or
update timestamp.

TUI enables this outer retry only for automatic pending-input recovery. Ordinary user
commands, Goal-only continuation, preflight exceptions, cancellation, and turns with
output or tool lifecycle are never replayed automatically. `PendingResumeCoordinator`
coalesces durable inbox wake-ups and owns the bounded timer. Intermediate retryable
failures remain silent; a final failure is displayed once with its canonical message.

## Cross-Surface Behavior

| Surface | Recovery Behavior |
| --- | --- |
| CLI/TUI | After Session activation, restore interaction first, then read inbox to create Runtime; bounded outer retry applies only to zero-output, zero-tool-side-effect durable pending input |
| Web | Fresh load replays the question; starts a pending-only turn after the answer and projects bounded outer-recovery state |
| ACP | `session/load` replays the question and continues without an extra prompt; pending input shares Web's retry decision, while a Goal failure is projected but not retried automatically |
| headless/print | Automatically rejects inexpressible interactions and continues with fail-closed result |

Fork does not inherit parent Session pending interactions. Conversation rewind removes interaction events along with the corresponding conversation suffix.

## Qualification Requirements

- Deterministic tests prove request-before-surface, response-before-continue, size budgets, idempotent recovery, fork/rewind isolation, and HTTP schema;
- Production Web GUI uses real DeepSeek plus one injected `503` to verify the visible question card, `retry_scheduled -> recovered`, one `Write`, no repeated question after fresh reload, and zero browser faults;
- A production ACP child uses SDK stdio and `session/load`, then proves attempt-two recovery after one injected `503`, one `Write`, durable acknowledgement, normal `session/close`, and EOF;
- A raw PTY launches the production CLI with `--resume` and uses the real Question/Review keyboard path to prove one `Write`, final text, durable acknowledgement, and normal exit without signal fallbacks;
- Every success receipt and failure diagnostic is bounded and structural, with no credentials, prompt/body text, absolute temporary paths, or raw Provider data.
