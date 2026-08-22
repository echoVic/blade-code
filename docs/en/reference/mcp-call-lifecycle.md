# MCP Tool Call Lifecycle

Blade binds each MCP `tools/call` to the current Agent tool call, uniformly handling Session cancellation, idle timeout, hard total timeout, and `notifications/progress`.

## Cancellation and Timeout

`ExecutionContext.signal` is passed directly into the MCP SDK. When a user stops a task, Session disposes, or streaming epoch discards:

1. The SDK terminates the local pending request;
2. A protocol cancellation is sent to MCP servers that support cancellation;
3. Blade restores the SDK's timeout wrapper as `AbortError`, avoiding false reports of user cancellations as timeouts;
4. ToolExecutor generates a recoverable interruption result, preventing late responses from entering the next round of model context.

Each server can be configured with:

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "timeout": 300000,
      "idleTimeout": 60000
    }
  }
}
```

- `timeout`: Hard total timeout for the complete tool call, default 5 minutes;
- `idleTimeout`: Idle timeout for no response or progress, default 1 minute;
- Progress refreshes the idle timeout but cannot break through the hard total timeout;
- Both range from 1 second to 30 minutes, and `idleTimeout <= timeout`;
- Blade uses both SDK `maxTotalTimeout` and an independent AbortController to prevent broken transports from leaving permanently pending promises.

## Progress

Blade requests a progress token for MCP calls and validates progress returned by the server:

- `progress` must be a non-negative finite number;
- `total` must be a positive finite number;
- Progress cannot go backward;
- Each call receives at most 128 progress updates;
- Messages have null bytes removed and are truncated to 1000 characters;
- The Agent Loop's pending projection queue retains at most 256 entries to prevent unbounded memory growth from slow UI consumption.

Progress is projected through the unified `tool_progress` LoopEvent:

- TUI displays transient tool progress with tool-call identity;
- Web directly displays messages, percentages, and an accessible progress bar in collapsed tool groups;
- headless JSONL outputs `tool_progress`;
- ACP outputs standard `tool_call_update` with status remaining `in_progress`;
- Subagent progress uses independent child session/tool-call identity and does not pollute parent tools.

Progress is not written to model transcripts or durable conversations. The final `tool_result` remains the only MCP result entering the next round of model context.

## Qualification Evidence

- A real stdio MCP server covers progress tokens, sequential progress, parent abort, idle heartbeat, hard timeout, and PID reclamation;
- Deterministic tests cover configuration boundaries, illegal/backward/excessive progress, Loop ordering, and TUI/Web/headless/ACP projection;
- Real GPT completes ToolSearch → progressive MCP → Write, and captures both MCP and built-in Write progress;
- Production DeepSeek Web GUI displays `phase-one · 33%` in collapsed tool groups, then completes final replies and fresh-tab recovery, with no residual MCP processes at task terminal state.

## Related Resources

- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [MCP Tool Result Safety Boundaries](/en/reference/mcp-tool-result-safety.md)
- [MCP Roots and Sampling](/en/reference/mcp-roots-sampling.md)
- [Tool Concurrency Model](/en/reference/tool-concurrency.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
