# MCP Tool Result 安全边界

Blade 在 MCP SDK `tools/call` 返回后、结果进入 ToolExecutor 和模型上下文前执行统一
归一化。普通 MCP 工具结果不会把未检查的 base64、`_meta` 或
`structuredContent` 原样写入 transcript、Web 事件或 ACP。

## 支持的内容

`CallToolResult.content` 支持：

- `text`：保留文本和 content part 边界；
- `resource` text：保留 URI、MIME type 和文本；
- `resource_link`：保留有界 name、URI、description 和 MIME type；
- `image` / `audio` / `resource` blob：解码后只向模型投影 size、SHA-256 和
  artifact 引用；
- `structuredContent`：作为标记清晰的 JSON 块加入普通 tool result。

server `_meta`、content `_meta`、annotations、icons 和其他扩展字段不会进入模型或
ToolResult metadata。MCP 工具结果始终是外部不可信数据，不会提升为 system message。

## 预算

硬限制：

- 每次最多 64 个 content parts；
- 单个 text/resource text 最多 1 MiB；
- 完整规范化文本最多 4 MiB；
- `structuredContent` JSON 最多 4 MiB，且仍受最终 4 MiB 总输出限制；
- 单个 binary 最多 8 MiB decoded bytes；
- 单次调用 binary 合计最多 16 MiB；
- protocol error 最多 4 KiB。

base64 在解码前先检查编码长度和字符集，不能用超大 encoded string 触发额外 decoded
buffer。违反硬限制会把该工具调用标记为失败，不会把部分结果提交给 Agent。

## 大结果 Artifact

规范化文本超过 100 KiB 时，Blade 返回 8 KiB head + 2 KiB tail preview，并把完整结果
写入 Session 私有 artifact。模型可以使用 preview 中的绝对路径调用 `Read`。

artifact 存储：

```text
${BLADE_STORAGE_ROOT}/mcp-artifacts/<sha256(projectIdentity + sessionId)>/<sha256(content)>.<ext>
```

- 目录权限 `0700`；
- 文件权限 `0600`；
- source project identity 与 `sessionId` 共同决定 Session root，同名跨项目 Session
  不共享 artifact；
- 文件名使用内容 SHA-256，不含 server、tool 或用户输入；
- 已存在文件必须通过类型、owner、mode、size 和完整 hash 校验；
- 每个 Session 最多 256 个 artifact、64 MiB；
- image/audio/resource blob 与大型 text 使用同一内容寻址存储。

artifact 写入失败不会回退为 base64；模型只收到 hash、size 和
`content_omitted=true`。本地 TUI/Web/headless Session 可看到 artifact path。ACP
remote Session 只收到 opaque artifact ID，不暴露宿主路径。

## ToolResult Metadata

`metadata.mcpResult` 只包含：

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

Web server 在事件出口再次执行相同语义的 allowlist。旧 Session 或兼容调用即使携带
raw `mcpResult.content`，也不会通过 `tool.result` / `subagent.tool.result` 进入浏览器。
Headless JSONL 和 ACP 不发送原始 MCP metadata。

## 错误处理

`isError: true` 的文本经过以下处理：

- URL 替换为 `[redacted-url]`；
- Bearer token 和 `sk-*` key 替换为 `[redacted]`；
- 移除不安全控制字符；
- 按 UTF-8 bytes 截断到 4 KiB。

归一化失败、artifact quota、无效 base64 和未知 content type 使用同一有界错误路径。

## 验证

真实 stdio fixture 覆盖 text、structured content、image/audio、resource
text/blob、resource link、大结果、协议错误和超限结果。资格轨迹包含：

```text
ToolSearch
  -> rich MCP result
  -> binary hash/artifact projection
  -> large MCP result
  -> Read private text artifact
  -> Write proof
```

真实 GPT 和生产 DeepSeek Web GUI 均读取完整 artifact 中的 tail marker。GUI、
transcript 和 trace 不包含 base64、server `_meta` 或 API key；artifact 权限和 MCP
PID 回收均经过独立审计。

## 相关资源

- [MCP Tool Call 生命周期](mcp-call-lifecycle.md)
- [MCP Resources、Prompts 与订阅](mcp-resources-prompts.md)
- [MCP 故障恢复](mcp-fault-recovery.md)
- [MCP Session 隔离](mcp-session-isolation.md)
- [测试与生产准出](../testing/qualification.md)
