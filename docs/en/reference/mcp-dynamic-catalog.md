# MCP Dynamic Tool Catalog

Blade supports MCP servers updating the tool catalog during Session runtime via `notifications/tools/list_changed`. Updates maintain atomicity across the server, Session, and Agent executor layers; the model never sees a partially refreshed state.

## Stable Tool Identity

The MCP transport uses the original tool names declared by the server. The model, permission system, tool whitelist, and `ToolSearch` use stable provider names:

```text
mcp__<server>__<tool>
```

Server and tool segments are normalized; unsafe or excessively long segments receive a SHA-256 digest suffix. Same-named tools from different servers do not conflict, and MCP tools cannot override Blade built-in tools.

## Refresh Protocol

1. After connection establishment, `McpClient` paginates and reads the complete `tools/list`.
2. A `list_changed` notification synchronously registers a refresh barrier; duplicate notifications within a short window are merged.
3. The Agent waits for the barrier before the next provider request.
4. After the complete catalog passes validation, `McpRegistry` publishes a monotonically increasing revision and `added`, `removed`, `updated` deltas.
5. The base registry in the Session and all active executors replace the complete MCP projection atomically.
6. Newly added tools remain deferred and must load their schema via `ToolSearch`; tools that have not changed and are already loaded retain their loaded state.

Catalog changes enter the next provider request as transient control messages but are not written to persistent session history.

## Boundaries

Catalog refresh per server is subject to the following limits:

- At most 100 pages;
- At most 1,000 tools;
- Single tool name capped at 256 characters;
- Single description capped at 16 KiB;
- Single input schema capped at 256 KiB;
- Complete catalog capped at 4 MiB;
- cursors must not repeat;
- Both raw tool names and provider tool names must not duplicate.

Any pagination, schema, size, or naming validation failure rejects the new catalog entirely. The previous valid revision continues to serve, the existing MCP connection remains usable, and a `catalogRefreshFailed` diagnostic event is emitted.

## Session Isolation

Sessions project only their immutable MCP server snapshots. The Agent's `toolWhitelist` and `toolBlacklist` are reapplied at each revision, so catalog deltas also only include tools visible to that executor. Sub-Agents, CLI, Web, and ACP do not share a mutable global tool catalog.

Catalog subscriptions are released when an executor is destroyed. When a Session is destroyed, subscriptions are released before closing the MCP client and transport, preventing disconnection events from writing to released registries.

## Surface Events

- TUI: displays transient `MCP Catalog` tool messages;
- Headless JSONL: sends `mcp_catalog_changed`;
- Web: sends `mcp.catalog.changed`, sub-agents use `subagent.mcp.catalog.changed`;
- ACP: sends `agent_message_chunk` catalog summary.

These events include the revision, server name, and added/removed/updated provider names.

## Verification

Deterministic stdio fixtures cover pagination, notification merging, add/update/remove deltas, invalid duplicate catalog rollback, tool calls, and process reclamation. Real API qualification covers:

```text
ToolSearch
  -> mcp__dynamic__unlock_catalog
  -> list_changed / revision barrier
  -> ToolSearch
  -> mcp__dynamic__dynamic_marker
  -> Write
```

Production Web GUI uses DeepSeek to execute the same trajectory and checks catalog cards, final files, browser console, MCP traces, and PID reclamation.

## Related Documentation

- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md)
- [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md)
- [MCP OAuth Lifecycle](/en/reference/mcp-oauth-lifecycle.md)
- [Tool List](/en/reference/tool-list.md)
