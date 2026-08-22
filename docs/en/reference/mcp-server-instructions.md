# MCP Server Instructions

Blade reads MCP `InitializeResult.instructions` and treats them as tool usage instructions provided by the current connection. Instructions are not Blade, project, or user instructions and cannot gain elevated privileges.

## Session Lifecycle

Each Session-private MCP client reads instructions once after initialize completes:

```text
connect generation N
  -> hash complete source + normalize bounded projection
  -> publish instructions added
  -> provider boundary receives scoped documentation

transport closed
  -> publish instructions removed
  -> remove prior documentation from in-memory model context

connect generation N+1
  -> publish the new immutable instructions
```

After a same-named server reconnects, instructions from the old generation are not retained. New Agents/executors start from the current Session snapshot; dynamic connection changes are published via monotonic revisions.

## Security Boundary

Instructions come from external servers and undergo the following processing before entering the model:

- NFKC Unicode normalization;
- Removal of Unicode `Cf`, `Co`, `Cn`, directional control, tag, private-use, and unsafe C0 characters;
- Before normalization, at most 1 MiB of source is read;
- At most 8 KiB per server;
- At most 32 KiB cumulative across all servers per Session;
- Source bytes, projected bytes, SHA-256, truncated flag, and detailsOmitted flag are preserved;
- Server names and body content are encoded as JSON literals, with additional escaping for `<`, `>`, `&`, so they cannot close `<system-reminder>` tags;
- The reminder explicitly states that the content is merely external untrusted tool documentation for the corresponding server.

Server instructions cannot:

- Override system, user, project, permission, trust, or safety instructions;
- Authorize tool calls, network operations, or destructive actions;
- Request credentials, host files, or other Session data;
- Elevate their own content to system messages.

## Provider Context

Local TUI, Web, and headless Sessions inject current instructions at the provider boundary. Each server uses an independent control message with provenance metadata. When a connection is revoked, Blade removes that server's previous control message; snapshot replacement first cleans up all stale instruction messages.

ACP remote Sessions retain only source bytes, SHA-256, and lifecycle state; they do not send server-controlled body text or host paths to the model/IDE:

```text
detailsOmitted=true
projectedBytes=0
sha256=<raw-source-hash>
```

## User Projection

- TUI: `MCP Instructions` completed card;
- Headless JSONL: `mcp_instructions_changed`;
- Web: `mcp.instructions.changed`;
- Subagent Web: `subagent.mcp.instructions.changed`;
- ACP: `agent_message_chunk` provenance summary;
- `/mcp instructions [server]`: view the current Session snapshot;
- Web MCP panel: displays the safe body text, SHA-256, and truncation status.

## Verification

Real stdio fixtures use two generations of processes:

1. V1 instructions provide `INSTRUCTION_CODE_42`;
2. After the first-generation process crashes, `removed` is published;
3. The restored connection provides V2 with `INSTRUCTION_CODE_84`;
4. The old body text no longer takes effect;
5. The ACP snapshot contains no body text;
6. Both generations' PIDs are reclaimed.

Both real GPT and production DeepSeek Web GUI obtain parameters from scoped server instructions and call tools without the user providing code. The fixture also includes hidden Unicode and bogus `</system-reminder>` overrides; the model still completes the bounded trajectory, and the GUI, trace, and transcript contain no hidden characters or credentials.

## Related Resources

- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [MCP Dynamic Tool Catalog](/en/reference/mcp-dynamic-catalog.md)
- [MCP Completion](/en/reference/mcp-completion.md)
- [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md)
- [MCP Logging and Diagnostics](/en/reference/mcp-logging.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
