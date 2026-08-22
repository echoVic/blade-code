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
- Web catalog and Session SSE restore `pendingInteraction` along with the original question card;
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

## Cross-Surface Behavior

| Surface | Recovery Behavior |
| --- | --- |
| CLI/TUI | After Session activation, restore interaction first, then read inbox to create Runtime |
| Web | Fresh load replays question; automatically starts pending-only turn after answer |
| ACP | `session/load` replays question, automatically continues without extra prompt after answer |
| headless/print | Automatically rejects inexpressible interactions and continues with fail-closed result |

Fork does not inherit parent Session pending interactions. Conversation rewind removes interaction events along with the corresponding conversation suffix.

## Qualification Requirements

- Deterministic tests prove request-before-surface, response-before-continue, size budgets, idempotent recovery, fork/rewind isolation, and HTTP schema;
- Real GPT recovers from a preseeded pending Session via Web, ACP, and TUI and actually calls `Write`;
- Production Web GUI uses real DeepSeek to verify fresh-load question cards, answers, auto-continuation, changed files, fresh reload not repeating questions, and zero application console errors.
