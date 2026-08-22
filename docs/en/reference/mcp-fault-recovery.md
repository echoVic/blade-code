# MCP Fault Recovery

Blade provides bounded, cancellable connection recovery for each Session-private MCP client. When a stdio process exits, remote transport terminates, HTTP Session expires, or health check fails, old tools and content catalogs are not left exposed.

## Recovery State Machine

Each client has exactly one connection generation and one recovery task:

```text
connected
  -> reconnecting (revoke old catalog and reject in-flight calls)
  -> connected + recovered
  -> error + failed
```

- Both initial connection and automatic recovery are single-flight;
- Manual disconnect, Session dispose, and configuration unload increment the generation, cancel backoff, and close in-progress transports;
- Late-arriving old generations cannot publish catalogs, restore subscriptions, or overwrite new connections;
- New generations renegotiate the current Session's MCP logging level;
- Server instructions from the old generation are revoked immediately; new instructions are only published after a complete handshake;
- In-flight Completions are not replayed across generations; candidates returned by old clients are rejected;
- SDK transport close rejects all pending requests; in-flight `tools/call` do not hang permanently;
- The reconnect timer uses `unref()` so it does not prevent CLI or headless process exit.

After connection closes, Blade first atomically removes that server's tools, resources, templates, and prompts, then enters backoff. Recovery connections only republish after the complete catalog passes validation. The model therefore cannot call old tools that still point to dead transports.

## Fault Identification

The following signals feed into the unified recovery state machine:

- `onclose` for stdio / SSE / Streamable HTTP;
- Consecutive terminal errors such as `ECONNRESET`, `EPIPE`, `ETIMEDOUT`, SSE reconnect exhausted;
- HTTP 404 / JSON-RPC session-not-found;
- Consecutive MCP `ping` failures reaching the health check threshold.

Ordinary protocol validation or notification handler errors do not immediately restart transports. Remote transport intermediate errors only force close after reaching a threshold, causing the SDK to reject pending requests and establish a new Session.

## Configuration

Automatic recovery is enabled by default:

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "recovery": {
        "enabled": true,
        "maxAttempts": 5,
        "initialDelayMs": 1000,
        "maxDelayMs": 30000,
        "jitterRatio": 0.2,
        "terminalErrorThreshold": 3
      },
      "healthCheck": {
        "enabled": true,
        "interval": 30000,
        "timeout": 10000,
        "failureThreshold": 3
      }
    }
  }
}
```

Boundaries:

- `maxAttempts`: 0–20; 0 or `enabled: false` means no automatic reconnection after catalog revocation;
- `initialDelayMs` / `maxDelayMs`: 10 ms–5 minutes; exponential backoff is bounded by max;
- `jitterRatio`: 0–1, defaults to 20% symmetric jitter;
- `terminalErrorThreshold`: 1–10;
- health interval: 10 ms–5 minutes;
- health timeout: 10 ms–1 minute;
- health failure threshold: 1–10.

Invalid values fail closed when creating a client, preventing zero-delay crash loops.

## Health Checks

Health checks call the protocol `ping` and no longer treat cached tools or server info as evidence of connection liveness. ping uses SDK timeout, AbortSignal, and a hard total timeout. After reaching the threshold, only a `health_check` is submitted to the unified recovery state machine; no separate disconnect/connect runs in parallel.

## Resource Subscription

Subscription state is split into desired and active:

- Explicit user subscribe writes to desired;
- Transport close only clears active;
- After the new connection obtains the resource catalog, URIs that still exist and for which the server supports subscribe are automatically restored;
- Dynamic catalog removal of resources revokes active; resubscription occurs when the resource reappears;
- Manual unsubscribe or Session dispose clears both desired and active.

Each server remains subject to the 100 Session-private subscription limit.

## Async Task Recovery

Explicitly enabled MCP Tasks enter `interrupted` when transport closes; Blade `mcp_task_*` ownership is not lost. After the new generation connects, `tasks/get` is re-executed, with simultaneous validation of the original task ID and `createdAt`; identity changes fail closed. Stream breaks during `tasks/result` retrieval also recover and retry within the remaining local lifetime. Session dispose or explicit disconnect cancels tasks rather than continuing recovery in the background. See [MCP Async Tasks](/en/reference/mcp-tasks.md) for details.

## Observability

Connection events include monotonic revision, server, phase, reason, attempt, maxAttempts, and optional nextRetryAt. Errors have URLs, Bearer/API keys removed and are capped at 512 bytes.

- TUI: `MCP Connection` completed notification;
- Headless JSONL: `mcp_connection_changed`;
- Web: `mcp.connection.changed`;
- Subagent Web: `subagent.mcp.connection.changed`;
- ACP: `agent_message_chunk` status summary;
- Web MCP management panel: `Recovering n/m`, Disconnect can cancel recovery.

Events inject transient control messages at the provider boundary and do not enter the durable transcript. Error text is for user diagnostics only and is not injected into model control messages, preventing malicious transport errors from forming prompt injection.

## Verification

Real stdio fixtures exit the first-generation process during `tools/call` and verify:

1. Pending calls receive `Connection closed`;
2. Old tools/content revisions are atomically revoked;
3. The second-generation process publishes a different catalog;
4. Desired resource subscriptions are automatically restored;
5. Manual disconnect can cancel backoffs that have not yet executed;
6. Session dispose reclaims all PIDs, timers, and transports.

Both real GPT and production DeepSeek Web GUI complete:

```text
subscribe + read
  -> MCP process crash
  -> reconnecting / catalog removal
  -> bounded recovery / subscription restore
  -> recovered / ToolSearch
  -> recovered tool + resource read
  -> Write
```

## Related Resources

- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [MCP Dynamic Tool Catalog](/en/reference/mcp-dynamic-catalog.md)
- [MCP Resources, Prompts, and Subscriptions](/en/reference/mcp-resources-prompts.md)
- [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md)
- [MCP Logging and Diagnostics](/en/reference/mcp-logging.md)
- [MCP Server Instructions](/en/reference/mcp-server-instructions.md)
- [MCP Completion](/en/reference/mcp-completion.md)
- [MCP Async Tasks](/en/reference/mcp-tasks.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
