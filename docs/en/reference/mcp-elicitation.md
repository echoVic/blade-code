# MCP Elicitation

Blade supports MCP `elicitation/create`, allowing Session-private MCP servers to request structured non-sensitive input during tool execution, or guide users through external URL flows.

## Capability Negotiation

`McpClient` only declares capabilities that are actually implemented:

```json
{
  "elicitation": {
    "form": { "applyDefaults": false },
    "url": {}
  }
}
```

Blade only declares capabilities for which it has real request handlers. Each `SessionRuntime` uses an exclusive `McpRegistry`, so elicitation does not cross-contaminate responses across Sessions or workspaces. Roots and explicit opt-in Sampling have independent handlers and security policies; see [MCP Roots and Sampling](/en/reference/mcp-roots-sampling.md) for details.

MCP tools are deferred by default. The model first activates tool schemas via `ToolSearch`, then calls tools. An MCP client allows only one interactive tool call at a time; overlapping calls are directly rejected to avoid incorrectly associating user responses when the protocol lacks parent call IDs.

## Form Mode

Blade supports the following in MCP schemas:

- strings, along with date, date-time, email, and URI format hints;
- numbers and safe integers;
- booleans;
- string enums, oneOf;
- multi-select string enum arrays;
- required, default, length, range, and option count constraints.

Requests contain at most 32 fields, with at most 100 options per field. Field names `__proto__`, `constructor`, and `prototype` are rejected before rendering. Submitted content is limited to 64 KiB and is re-validated against the original requested schema before being sent to the server; extra fields, wrong types, out-of-bounds values, and unsafe integers are uniformly cancelled.

Forms are only suitable for non-sensitive data. API keys, payments, OAuth, and other secrets must use URL mode so that data is submitted directly to the MCP server rather than passing through Blade, model context, or Hooks.

## URL Mode

Blade only accepts absolute HTTP(S) URLs without username/password:

- TUI displays the server, domain, and full URL, opening locally only after explicit user confirmation;
- Web only opens with `noopener,noreferrer` on real click gestures;
- ACP displays the full URL and leaves opening to the IDE user; it does not operate the Agent host browser;
- headless returns `cancel` when there is no interaction surface.

Blade receives `notifications/elicitation/complete` and publishes an internal completion event. Tool calls, Session cancellation, transport closure, or interaction timeouts all deterministically return `cancel`, leaving no hanging requests.

## Cross-Platform Interaction

TUI, Web, and ACP share the `mcpElicitation` type of `ConfirmationHandler`:

- TUI provides per-field input, selection, and pre-submission review;
- Web provides accessible structured cards, background task attention state, and precise stale-session routing;
- ACP projects enums, booleans, and URLs as standard permission choices;
- Required free-text, numbers, and multi-select that ACP cannot express fail closed; fields with defaults must have the user explicitly choose to use the default value.

Web Bus events contain only the server, message, and schema, not user-filled content. Answers return to the active request for the exact current `sessionId + projectPath` only via `/permissions/:id` and are not written to the Session transcript.

## Hooks

Two new trusted Hook events are added:

- `Elicitation`: Executed before displaying the UI; can return accept, decline, cancel, and optional content;
- `ElicitationResult`: Executed before the response is sent to the MCP server; can review or replace the result.

Hook return values still undergo original MCP schema validation. Configuration-type Hooks are protected by Hook Trust digests; Hooks can see form content, so do not put secrets in Forms, and do not record input in Hook output or logs.

## Qualification Evidence

- A real stdio MCP server covers Form, URL, completion notification, cancellation, no-UI, illegal responses, and overlapping calls;
- Real GPT activates MCP tools via ToolSearch, then continues Write after completing elicitation;
- Production DeepSeek Web GUI covers MCP tool approval, structured forms, task attention, final replies, fresh-tab recovery, and stdio PID reclamation.

## Related Resources

- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [Hooks](/en/guides/hooks.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
