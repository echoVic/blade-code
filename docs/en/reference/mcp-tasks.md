# MCP Async Tasks

Blade supports the MCP SDK's experimental Tasks protocol for mapping task-capable `tools/call` to Session-private background tasks. This capability is disabled by default; tasks can only be created when explicitly enabled in server configuration.

## Execution Semantics

`execution.taskSupport` in the MCP tool catalog determines the call method:

- `required`: dynamic `mcp__<server>__<tool>` calls automatically create background tasks;
- `optional`: normal dynamic tool calls remain foreground-synchronous; the model can explicitly call `StartMcpTask`;
- `forbidden` or undeclared: cannot be executed via the Tasks path.

Task creation returns only a Blade-generated `mcp_task_<uuid>`. The original server task ID is stored only inside the Session runtime and does not enter model, Web, TUI, ACP, headless, or slash command output.

```text
task-capable tools/call
  -> opaque mcp_task_* ID
  -> tasks/get polling
  -> TaskOutput
  -> normalized MCP tool result
```

`TaskOutput` is the shared read entry point for shell, subagent, and MCP background tasks. `ListMcpTasks` lists only tasks created in the current Session; Blade does not adopt arbitrary server tasks returned by `tasks/list`. `CancelMcpTask` first requests `tasks/cancel`, then unconditionally terminates the local watcher.

## Configuration

Enabled independently per server:

```json
{
  "mcpServers": {
    "build": {
      "type": "stdio",
      "command": "build-mcp",
      "tasks": {
        "enabled": true,
        "defaultTtlMs": 600000,
        "pollIntervalMs": 500,
        "maxTasksPerSession": 8,
        "maxLifetimeMs": 1800000
      }
    }
  }
}
```

Boundaries:

- `enabled` must be explicitly `true`;
- TTL and local lifetime range from 10 seconds to 24 hours;
- `defaultTtlMs` cannot exceed `maxLifetimeMs`;
- Poll interval ranges from 100 ms to 10 seconds; malicious server values are clamped;
- At most 32 tasks per Session, at most 256 per process;
- Tasks exceeding local lifetime are cancelled and marked as failed.

## Session and Connection Security

Task ownership is bound to both Session ID and canonical execution workspace. Cross-Session, cross-workspace, or forged task IDs all fail closed. Before Session dispose, server unregister, disconnect, and reconnect, corresponding tasks are cancelled and watchers are cleaned up.

On unexpected transport close, tasks enter `interrupted`:

1. Wait for generation-fenced bounded recovery of that Session client;
2. Reinvoke `tasks/get` on the new connection;
3. Verify that the original task ID and `createdAt` have not changed;
4. When `tasks/result` itself breaks the stream, recovery and retry are performed the same way;
5. Fail closed when lifetime expires or identity changes.

`input_required` delivers the associated Elicitation or Sampling request via the standard `tasks/result` side channel. Requests continue to use the original Session interaction handler: Sampling is disabled by default and requires per-call approval, and Elicitation is constrained by current TUI/Web/ACP expression capabilities and cancellation.

## Result Safety

Task results reuse the [MCP Tool Result Safety Boundary](/en/reference/mcp-tool-result-safety.md):

- text, structured content, and binary use shared hard budgets;
- `_meta` does not enter the model;
- Large results are converted to Session-private 0600 artifacts;
- ACP remote receives only opaque artifact IDs;
- error, status message, and reconnect text undergo NFKC normalization, hidden Unicode cleaning, credential/URL redaction, and a 1 KiB cap;
- Status messages are for user diagnostics only; they cannot authorize operations or be injected as model instructions.

## Interaction Entry Points

Model tools:

```text
StartMcpTask
ListMcpTasks
CancelMcpTask
TaskOutput
```

CLI/TUI/ACP:

```text
/mcp tasks [server]
/mcp task <mcp_task_*>
/mcp task-cancel <mcp_task_*>
```

Lifecycle is uniformly projected to:

- TUI `MCP Task` card;
- headless `mcp_task_changed`;
- Web `mcp.task.changed`, where the same card updates from running to terminal;
- subagent Web `subagent.mcp.task.changed`;
- ACP `agent_message_chunk`.

The Web MCP panel displays each server's opt-in status, Session limit, and poll interval.

## Verification

Real stdio qualification covers required/optional/disabled, explicit backgrounding, ownership, cancellation, Session dispose, two types of stream-break recovery for `tasks/get` and `tasks/result`, generation identity, Unicode cleaning, result metadata redaction, and full PID reclamation.

Both real GPT and production DeepSeek Web GUI complete:

```text
ToolSearch
-> required MCP task
-> opaque mcp_task_*
-> TaskOutput
-> Write
```

The GUI also verifies that running-state cards update in-place to completed, MCP panel opt-in parameters and production builds work; original server task IDs, Bearer metadata, and host paths do not enter the model or page.

## Related Resources

- [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md)
- [MCP Tool Result Safety Boundary](/en/reference/mcp-tool-result-safety.md)
- [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md)
- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
