# MCP Tool Result Safety Boundaries

Blade performs uniform normalization after the MCP SDK `tools/call` returns and before results enter ToolExecutor and model context. Ordinary MCP tool results do not write unchecked base64, `_meta`, or `structuredContent` verbatim to transcripts, Web events, or ACP.

## Supported Content

`CallToolResult.content` supports:

- `text`: Preserves text and content part boundaries;
- `resource` text: Preserves URI, MIME type, and text;
- `resource_link`: Preserves bounded name, URI, description, and MIME type;
- `image` / `audio` / `resource` blob: After decoding, projects only size, SHA-256, and artifact references to the model;
- `structuredContent`: Added to ordinary tool results as a clearly marked JSON block.

Server `_meta`, content `_meta`, annotations, icons, and other extension fields do not enter the model or ToolResult metadata. MCP tool results are always external untrusted data and are never promoted to system messages.

## Budgets

Hard limits:

- At most 64 content parts per call;
- Single text/resource text at most 1 MiB;
- Complete normalized text at most 4 MiB;
- `structuredContent` JSON at most 4 MiB, and still subject to the final 4 MiB total output limit;
- Single binary at most 8 MiB decoded bytes;
- Combined binaries per call at most 16 MiB;
- Protocol errors at most 4 KiB.

base64 is checked for encoding length and character set before decoding; oversized encoded strings cannot trigger additional decoded buffers. Violating hard limits marks the tool call as failed, and partial results are not submitted to the Agent.

## Large Result Artifacts

When normalized text exceeds 100 KiB, Blade returns an 8 KiB head + 2 KiB tail preview and writes the complete result to a Session-private artifact. The model can call `Read` using the absolute path in the preview.

Artifact storage:

```text
${BLADE_STORAGE_ROOT}/mcp-artifacts/<sha256(projectIdentity + sessionId)>/<sha256(content)>.<ext>
```

- Directory permissions `0700`;
- File permissions `0600`;
- Source project identity and `sessionId` together determine the Session root; same-named cross-project Sessions do not share artifacts;
- Filenames use content SHA-256 and contain no server, tool, or user input;
- Pre-existing files must pass type, owner, mode, size, and complete hash verification;
- At most 256 artifacts, 64 MiB per Session;
- Image/audio/resource blobs and large text use the same content-addressed storage.

Artifact write failures do not fall back to base64; the model receives only hash, size, and `content_omitted=true`. Local TUI/Web/headless Sessions can see the artifact path. ACP remote Sessions receive only opaque artifact IDs and do not expose host paths.

## ToolResult Metadata

`metadata.mcpResult` contains only:

```text
isError
contentCount
textBytes
structuredBytes
artifactCount
truncated
binaryOmitted
artifacts[]: id/kind/size/sha256/persisted/mimeType/sourceUri/path?
```

The Web server executes the same semantic allowlist again at event egress. Even if old Sessions or compatibility calls carry raw `mcpResult.content`, it does not enter the browser via `tool.result` / `subagent.tool.result`. Headless JSONL and ACP do not send raw MCP metadata.

## Error Handling

Text with `isError: true` undergoes the following processing:

- URLs are replaced with `[redacted-url]`;
- Bearer tokens and `sk-*` keys are replaced with `[redacted]`;
- Unsafe control characters are removed;
- Truncated to 4 KiB by UTF-8 bytes.

Normalization failures, artifact quota, invalid base64, and unknown content types use the same bounded error path.

## Verification

Real stdio fixtures cover text, structured content, image/audio, resource text/blob, resource links, large results, protocol errors, and over-limit results. The qualification trajectory includes:

```text
ToolSearch
  -> rich MCP result
  -> binary hash/artifact projection
  -> large MCP result
  -> Read private text artifact
  -> Write proof
```

Both real GPT and production DeepSeek Web GUI read the tail marker from complete artifacts. GUI, transcripts, and traces contain no base64, server `_meta`, or API keys; artifact permissions and MCP PID reclamation undergo independent audits.

## Related Resources

- [MCP Tool Call Lifecycle](/en/reference/mcp-call-lifecycle.md)
- [MCP Resources, Prompts, and Subscriptions](/en/reference/mcp-resources-prompts.md)
- [MCP Fault Recovery](/en/reference/mcp-fault-recovery.md)
- [MCP Session Isolation](/en/reference/mcp-session-isolation.md)
- [Testing and Production Qualification](/en/testing/qualification.md)
