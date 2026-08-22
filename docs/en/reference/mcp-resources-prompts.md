# MCP Resources, Prompts, and Subscriptions

Blade supports Resources, Resource Templates, Prompts, and Resource Subscriptions on Session-private MCP connections. Catalog state, reads, and notifications do not go through process-level global registries.

## Model Tools

MCP content capabilities are exposed via deferred builtin tools; the model first uses `ToolSearch` to load the required schema:

| Tool | Description |
|------|-------------|
| `ListMcpResources` | List resources for the current Session |
| `ListMcpResourceTemplates` | List parameterized resource templates |
| `ReadMcpResource` | Read a resource by server and URI |
| `ListMcpPrompts` | List prompts and parameter definitions |
| `GetMcpPrompt` | Validate parameters and resolve a prompt |
| `ManageMcpResourceSubscription` | Explicitly subscribe or unsubscribe from resource updates |

Resource, template, and prompt lists all perform full pagination and do not rely on a single-page startup cache.

## User Commands

Active Sessions provide the following commands:

```text
/mcp resources [server]
/mcp prompts [server]
/mcp prompt <server> <name> [key=value...]
```

TUI hands resolved prompts to the Agent as expanded commands; ACP returns the complete role-based prompt content. Headless Agents can use the same deferred tools; directly executing `/mcp resources|prompts|prompt` before Session establishment fails closed and does not create process-level MCP connections.

## Catalog Lifecycle

After connection establishment, Blade reads the complete catalog of resources, resource templates, and prompts. `notifications/resources/list_changed` and `notifications/prompts/list_changed` synchronously register a refresh barrier. The Agent waits for refresh completion before the next provider request.

Each valid change publishes a monotonic revision and `added`, `removed`, `updated` deltas. Resources and templates are fetched as a group and committed after validation completes; on failure, the previous valid snapshot is retained. Duplicate notifications within a short window are merged; continuous notifications are not lost due to the three-round refresh limit.

Catalog limits:

- At most 100 pages, 1,000 entries per type;
- URIs capped at 8,192 characters;
- Names capped at 256 characters;
- Descriptions capped at 16 KiB;
- Prompts capped at 64 parameters;
- Complete catalog per type capped at 4 MiB;
- cursors and protocol identities must not duplicate.

## Resource Reading

`ReadMcpResource` requires the URI to exist in the current server catalog. A single response may contain up to 64 content parts; all text parts are retained, rather than only returning the first item.

Individual text items are capped at 1 MiB; complete results are capped at 4 MiB. Binary blobs do not write base64 into model context, events, or transcripts; instead, they are converted to:

```json
{
  "size": 1234,
  "sha256": "...",
  "omitted": true
}
```

MCP resources are external untrusted content. They enter model context as ordinary tool results and are not elevated to system messages. The text, structured content, and binary of ordinary `tools/call` use independent but consistent safe projection; see [MCP Tool Result Safety Boundary](/en/reference/mcp-tool-result-safety.md).

## Prompt Resolution

`GetMcpPrompt` only accepts prompts that exist in the catalog:

- Unknown parameters are rejected;
- Missing required parameters are rejected;
- Prototype-polluting parameter names are rejected;
- `user` / `assistant` roles are preserved;
- Text and embedded resources use the same budgets as resource reading;
- Image/audio blobs project only size and SHA-256;
- Server `_meta`, icons, or annotations are not retained.

Resolved results remain ordinary tool results and do not possess system instruction privileges.

## Completion

`CompleteMcpArgument` only requests candidates for prompt parameters or resource template variables in the current Session catalog. Input context, concurrency, timeouts, and output values all have independent budgets; candidates undergo Unicode normalization, hidden character cleaning, deduplication, and SHA-256 provenance. Candidates do not form system/control messages; see [MCP Completion](/en/reference/mcp-completion.md) for details.

## Resource Subscription

Subscriptions must be explicitly initiated via `ManageMcpResourceSubscription` and require the server to declare `resources.subscribe`. There is a limit of 100 subscriptions per Session/server.

Upon receiving `notifications/resources/updated`, Blade does not automatically read or inject new content; it only sends a revision notification and prompts the model to re-invoke `ReadMcpResource`. Unsubscription is permitted for scenarios where the resource has been removed from the catalog. On abnormal disconnection, active subscriptions are released along with the transport; desired subscriptions are restored after the new connection obtains a valid resource catalog; manual disconnect or Session dispose clears both.

## Surface Events

- TUI: transient `MCP Content` / `MCP Resource` tool messages;
- Headless JSONL: `mcp_content_changed` / `mcp_resource_updated`;
- Web: `mcp.content.changed` / `mcp.resource.updated`;
- Subagent Web: `subagent.mcp.content.changed` / `subagent.mcp.resource.updated`;
- ACP: `agent_message_chunk` revision summary.

Events only enter the current active view and the next provider boundary; they are not written to the durable transcript.

## Verification

Real stdio fixtures cover pagination, multi-part resources, blob summaries, prompt parameters, templates, dynamic catalogs, subscribe/unsubscribe, resource updates, and PID reclamation. Both real GPT and production DeepSeek GUI execute:

```text
ToolSearch
  -> ListMcpResources + ReadMcpResource + GetMcpPrompt + Subscribe
  -> MCP catalog mutation
  -> subscribed resource update
  -> re-list + re-read
  -> Write
```

## Related Documentation

- [MCP Dynamic Tool Catalog](/en/reference/mcp-dynamic-catalog.md)
- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md)
- [MCP Completion](/en/reference/mcp-completion.md)
- [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md)
- [Tool List](/en/reference/tool-list.md)
