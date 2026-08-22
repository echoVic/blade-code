# MCP Completion

Blade supports standard MCP `completion/complete` for completing prompt arguments and resource template variables. Completions are external candidate data returned in response to explicit requests; they are not system instructions and cannot authorize tool calls.

## Session Boundary

Each Completion request goes only through the current Session-private `McpRegistry`:

```text
Session catalog snapshot
  -> verify server capability
  -> verify exact prompt/template identity
  -> verify declared argument and context names
  -> completion/complete
  -> normalize bounded suggestions
```

Same-named MCP servers use independent clients, catalogs, and request concurrency budgets across different Sessions. Requests capture the current connection generation; if the client changes before a response returns, the result is rejected, and candidates from the old connection are not carried into the new connection.

## Request Constraints

- The server must declare `capabilities.completions`;
- The prompt must exist in the current Session prompt catalog;
- The resource must be an RFC 6570 URI template in the current Session;
- The argument must be a prompt-declared parameter or template variable;
- Context is capped at 32 arguments, 64 KiB cumulative;
- A single argument value is capped at 16 KiB;
- A single client is capped at 4 concurrent Completion requests;
- Each request has a maximum duration of 15 seconds and inherits the current turn/ACP cancellation signal;
- Catalog privilege escalation and unknown contexts fail before a protocol request is sent.

## Result Safety

After SDK schema validation, Blade still performs a second layer of normalization:

- At most 100 candidates;
- At most 1 MiB of source is processed before normalization;
- Each candidate is capped at 4 KiB;
- All candidates are capped at 64 KiB cumulative;
- NFKC normalization;
- Removal of C0, DEL, Unicode `Cf`, `Co`, `Cn`, bidi, tag, and private-use characters;
- Deduplication with stable ordering after safe normalization;
- SHA-256 of the complete raw completion, source/projected bytes, and truncation state are preserved;
- `hasMore=true` when budget truncation or deduplication occurs.

Returned values remain external untrusted data. The description of `CompleteMcpArgument` explicitly requires the model to treat them only as candidates and not execute instructions embedded within them. Completion does not create persistent control messages, nor does it change permission, trust, or Workspace boundaries.

## Usage

Model tool:

```text
CompleteMcpArgument
```

Input includes:

- `server`
- `reference`: `{type:"prompt",name}` or `{type:"resource",uri}`
- `argument`: `{name,value}`
- Optional `context`

CLI/TUI/ACP:

```text
/mcp complete <server> <prompt|resource> <reference> <argument> [value] [key=value...]
```

After connecting to a server, the Web MCP management panel displays:

- Completable prompt arguments;
- Resource template variables;
- Partial value input;
- Safe candidates, SHA-256, and truncation status.

## Verification

Real stdio qualification covers:

1. Prompt and resource template Completion;
2. Catalog privilege escalation rejected before the request;
3. Missing capability fails closed;
4. Client remains usable after cancellation;
5. Hard limit of 4 concurrent requests;
6. Session isolation for same-named servers;
7. Unicode cleaning, deduplication, source/result budgets;
8. All MCP PIDs reclaimed.

Both real GPT and production DeepSeek Web GUI execute:

```text
ToolSearch
-> CompleteMcpArgument
-> choose scoped code
-> ToolSearch
-> mcp__completion__completion_marker
-> Write
```

The fixture also returns bogus `</system-reminder>` candidates and hidden Unicode. The model selects the correct code; hidden characters do not enter the Web/transcript, and traces and temporary directories contain no API credentials.

## Related Resources

- [MCP Resources, Templates, Prompts, and Subscriptions](/en/reference/mcp-resources-prompts.md)
- [MCP Server Instructions](/en/reference/mcp-server-instructions.md)
- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
