# MCP Logging and Diagnostics

Blade implements standard `logging/setLevel` and `notifications/message` for each Session-private MCP client. Logs are intended for user diagnostics; they are not tool results and do not enter the model context.

## Protocol Lifecycle

After connection completes, if the server declares the `logging` capability, the client sends the current minimum log level:

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "logging": {
        "enabled": true,
        "level": "warning"
      }
    }
  }
}
```

- Logging is enabled by default, with a default level of `warning`;
- Supported levels: `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`;
- Servers that do not declare the capability will not receive `logging/setLevel`;
- Even after the server negotiates a level, Blade filters notifications below the threshold again on the client side;
- After connection recovery, the current runtime level is renegotiated on the new transport;
- `/mcp log-level <server> <level>` adjusts the current Session and does not modify snapshots of other Sessions.

Logging negotiation failure does not break tools/resources connections; Blade generates a bounded warning diagnostic.

## Security Boundary

`notification.params.data` is untrusted input. Before entering any UI, the following is enforced:

- Maximum depth 6, 128 nodes, 64 keys per object, 64 items per array;
- Safe projection capped at 16 KiB, displayed message capped at 8 KiB;
- Logger name capped at 256 bytes;
- URLs, Bearer tokens, `sk-*` and sensitive keys (token/password/secret/cookie/API key, etc.) are redacted;
- `_meta` is recursively discarded, control characters are removed;
- Each client receives at most 64 messages per second; exceeding the limit generates a one-time synthetic drop marker;
- A 64-entry in-memory ring is retained per server, 256 entries per Session.

Each log entry includes the SHA-256 of the safe projection, byte count, truncated flag, and detailsOmitted flag. Session dispose clears the ring; no host paths controlled by server name or logger are created.

ACP remote Sessions do not expose server-controlled messages, loggers, or host paths, and only project:

```text
[MCP log details omitted; sha256=<safe-projection-hash>]
```

## Provider Isolation

MCP logs only generate `mcp_log` user events. The Agent loop does not append system reminders, user control messages, or tool results for them, so prompt injection markers in logs will not enter the next provider request, nor will they be written to the durable model transcript.

Log severity does not indicate tool execution failure. In TUI/Web, all logs appear as completed diagnostic cards; `error` only affects the card label color and does not increment the failed tool count.

## Projection Across Surfaces

- TUI: `MCP Log` completed card;
- Headless JSONL: `mcp_log`;
- Web Session: `mcp.log`;
- Web Subagent: `subagent.mcp.log`;
- ACP: `agent_message_chunk`, remote entries contain only an opaque hash;
- `/mcp logs [server] [limit]`: query the current Session ring;
- Web MCP panel: view recent logs and adjust the negotiated level via custom level buttons.

Web management API:

```text
GET  /mcp/:server/logs?limit=20&afterRevision=0
POST /mcp/:server/logging-level
```

## Verification

Real stdio fixtures cover:

1. Filtering debug/info after `warning` negotiation;
2. Receiving all levels after runtime switch to `debug`;
3. Nested secrets, URLs, tokens, `_meta`, large objects, and burst traffic;
4. ACP details omission;
5. Session ring, PID, and transport reclamation.

A real GPT completion ToolSearch → logging MCP → Write verifies that the model context contains no log markers. Production DeepSeek Web GUI displays warning/error diagnostic cards, the final reply, and proof files, and verifies that no raw credentials remain in transcripts, traces, PIDs, ports, or temporary directories.

## Related Resources

- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [MCP Server Instructions](/en/reference/mcp-server-instructions.md)
- [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md)
- [MCP Tool Result Safety Boundary](/en/reference/mcp-tool-result-safety.md)
- [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
