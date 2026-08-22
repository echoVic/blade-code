# MCP Roots and Sampling

Blade supports MCP `roots/list` and provides a default-off, explicitly authorized basic `sampling/createMessage`. Both capabilities are bound to a single `SessionRuntime` and never use process-global workspace or model state.

## Session Roots

Each MCP client declares `roots` and registers a real request handler. The return value is the execution workspace frozen at Session creation:

- Normal CLI and Web Sessions return the current workspace;
- Independent tasks return the task worktree, not the source project;
- URIs are generated via canonical realpath and `pathToFileURL`;
- ACP remote Sessions return empty roots to avoid passing off Agent host paths as the IDE remote filesystem;
- Roots are immutable for the Session lifecycle, so `listChanged` is `false`.

MCP configuration identity and stdio default cwd still come from the source project. Roots represent the execution path that tools should operate on; the two must not be mixed.

## Sampling Configuration

Sampling is not declared by default. Each server must enable it explicitly:

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "sampling": {
        "enabled": true,
        "maxTokens": 1024,
        "maxRequestsPerToolCall": 2,
        "maxInputBytes": 65536
      }
    }
  }
}
```

| Configuration | Default | Hard Limit |
|------|--------|--------|
| `maxTokens` | 1024 | 4096 |
| `maxRequestsPerToolCall` | 2 | 8 |
| `maxInputBytes` | 64 KiB | 1 MiB |

Project-level configuration is protected by Workspace Trust. When configuration is invalid, Session creation fails closed; older connections without a Session sampling adapter do not declare the capability even if configuration enables it.

## Support Boundaries

Blade declares basic Sampling, not context or tools extensions:

- Supports text and JPEG, PNG, GIF, WebP image inputs;
- Images count against the server's `maxInputBytes` and reuse the shared 20-image, 5 MiB total attachment budget;
- Uses the current Session's frozen model, provider, and credentials;
- Server model hints cannot switch models; credentials are never returned to the server;
- Each request can tighten output tokens and temperature;
- Stop sequences are locally truncated before the response is sent;
- tools, `includeContext`, audio, task sampling, and other content blocks are uniformly rejected.

The same MCP tool call can request Sampling multiple times sequentially, but not overlapping. Request counts, input bytes, output tokens, and response bytes are all limited; parent tool cancellation, timeout, transport closure, or Session dispose aborts nested model requests.

## Human-in-the-loop

The MCP specification requires notifying users before Sampling. Blade enforces per-request approval for each request:

- TUI only shows "Allow this time/Deny" and does not provide Session or project memory;
- Web shows the server, token limit, and system/user preview, and likewise only allows one-time approval;
- ACP emits a standard one-shot permission request even in yolo mode;
- headless fails closed when there is no interaction surface.

Approval scope does not enter the normal tool approval store. A server cannot obtain persistent MCP tool permission first to bypass subsequent Sampling approvals.

## Qualification Evidence

- A real stdio MCP server proactively calls `roots/list` and `sampling/createMessage`;
- Deterministic tests cover URI encoding, ACP empty roots, capability negotiation, configuration boundaries, text/image, unsupported content, request counts, overlapping calls, and parent abort;
- Real GPT completes ToolSearch → MCP tool → nested sampling → Write, and verifies stdio PID reclamation;
- Production DeepSeek Web GUI covers normal MCP tool approval, Sampling one-shot approval, request preview, token limits, final replies, fresh-tab recovery, and zero Blade application errors.

## Related Resources

- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md)
- [MCP Elicitation](/en/reference/mcp-elicitation.md)
- [Workspace Model/Provider Isolation](/en/reference/workspace-model-resources.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
