# MCP Session Isolation

Blade resolves and connects MCP on a per-Session basis. The process-level Store is only a UI projection of server startup projects and cannot serve as runtime configuration for other Web, ACP, TUI, or subagent Sessions.

## Configuration Sources

Each `SessionRuntime` resolves independently using the source project path:

1. User `~/.blade/config.json` and `~/.blade/settings.json`
2. Target project's Workspace Trust-passed `.blade/config.json`
3. Target project's Workspace Trust-passed shared/local settings
4. User-level and target project trusted plugin MCP definitions
5. MCP servers provided by the ACP session
6. CLI `--mcp-config`

Same-named servers are overridden by later sources. `--strict-mcp-config` ignores workspace, plugin, and ACP sources and uses only CLI-explicit configuration.

MCP definitions from untrusted projects do not enter resolution results. When a server starts from project A, Sessions for project B do not inherit A's MCP; B's configuration is also not written back to the global Store.

## Connection Lifecycle

Each Session creates an independent `McpRegistry`:

- Process-global connections or tool objects are not reused;
- MCP tools are registered only with that Session's `ToolRegistry`;
- stdio servers default to using the source project as `cwd`;
- Explicit relative `cwd` is also resolved relative to the source project;
- Session dispose disconnects all clients in connected, connecting, and error states;
- Web terminal tasks are removed from runtime cache and immediately disposed after completion, failure, or cancellation; subsequent access relies on durable metadata to rebuild on demand;
- Project plugin MCP only provides configuration and does not cause process side effects at application startup;
- Form/URL elicitation is bound only to the Session interaction handler of the current MCP tool call; no interaction surface, call cancellation, or overlapping interactive calls return `cancel` and do not cross-answer across Sessions;
- Server instructions are isolated by connection generation and Session snapshot; ACP retains only the provenance hash;
- Completion reads only the current Session catalog; candidates, concurrency, and cancellation for same-named servers do not cross Sessions;
- Experimental MCP Tasks are disabled by default; when enabled, tasks are bound to both Session ID and execution workspace, expose only Blade `mcp_task_*`, and Session dispose cancels watchers and server tasks;
- `roots/list` returns the frozen execution workspace; task worktrees do not incorrectly expose the source project, and ACP remote Sessions do not expose host local paths;
- Sampling is disabled by default; when explicitly enabled, it remains bound to the current Session model and per-call permission requests; parent tool cancellation or Session dispose terminates nested model calls;
- Outer `tools/call` directly inherits the Session abort signal and is simultaneously constrained by idle/hard timeouts; progress is projected via unified LoopEvent and does not enter transcripts;
- OAuth login is an explicit user action outside the Session; local Sessions only consume existing credentials by endpoint/client/scopes, and ACP remote Sessions neither read host credentials nor start callbacks/browsers;
- Transport anomalies first revoke the current Session's old catalog, then execute single-flight bounded recovery via generation fence; Session dispose cancels backoffs and in-progress connections; restored resource subscriptions only come from that Session's desired set;
- `tools/call` binary and large text use a private artifact store isolated by Session hash; local Sessions can read absolute paths, while ACP remote receives only opaque IDs and does not expose host storage paths.

ACP remote-filesystem ownership follows the same Session-freeze rule:

- if either `readTextFile===true` or `writeTextFile===true` at Session initialization,
  the text-file owner is frozen as remote;
- if `fs` is absent or both capabilities are `false`, the Session keeps the local backend;
- transport reconnect does not change that owner, and capability changes require a new Session;
- `isAcpMode()` still means only that the current surface is ACP, not that the Session owns a
  remote filesystem.

The execution path for task worktrees remains the worktree, but MCP configuration identity and default cwd use `taskWorktree.originalWorkspaceRoot`. This is consistent with the `projectPath` / `workspacePath` dual-identity model.

## CLI Configuration Format

`--mcp-config` supports files, single-server JSON, and server maps:

```bash
blade --headless \
  --mcp-config ./mcp.json \
  --mcp-config '{"name":"review","type":"stdio","command":"review-mcp"}' \
  "review the repository"
```

Files can directly contain server maps, or use:

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "args": ["--stdio"],
      "cwd": "services/api"
    }
  }
}
```

CLI parsing is side-effect free. Explicit configuration enters only the current Session, does not modify the Store, and does not affect parallel Sessions.

## Related Resources

- [MCP Elicitation](/en/reference/mcp-elicitation.md)
- [MCP Roots and Sampling](/en/reference/mcp-roots-sampling.md)
- [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md)
- [MCP Tool Result Safety Boundary](/en/reference/mcp-tool-result-safety.md)
- [MCP Logging and Diagnostics](/en/reference/mcp-logging.md)
- [MCP Server Instructions](/en/reference/mcp-server-instructions.md)
- [MCP Completion](/en/reference/mcp-completion.md)
- [MCP Async Tasks](/en/reference/mcp-tasks.md)
- [MCP OAuth Lifecycle](/en/reference/mcp-oauth-lifecycle.md)
- [MCP Dynamic Tool Catalog](/en/reference/mcp-dynamic-catalog.md)
- [MCP Resources, Prompts, and Subscriptions](/en/reference/mcp-resources-prompts.md)
- [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md)
- [Workspace Trust](/en/guides/workspace-trust.md)
- [Configuration System](/en/configuration/config-system.md)
- [Tool Concurrency Model](/en/reference/tool-concurrency.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
