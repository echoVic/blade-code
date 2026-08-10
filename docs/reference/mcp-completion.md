# MCP Completion

Blade 支持标准 MCP `completion/complete`，用于补全 prompt 参数和 resource template
变量。Completion 是显式请求返回的外部候选数据，不是 system instruction，也不能
授权工具调用。

## Session 边界

每个 Completion 请求只通过当前 Session 私有 `McpRegistry`：

```text
Session catalog snapshot
  -> verify server capability
  -> verify exact prompt/template identity
  -> verify declared argument and context names
  -> completion/complete
  -> normalize bounded suggestions
```

同名 MCP server 在不同 Session 中使用独立 client、catalog 和请求并发预算。请求捕获
当前 connection generation；响应返回前 client 已变化时结果会被拒绝，不会把旧连接的
候选带入新连接。

## 请求约束

- server 必须声明 `capabilities.completions`；
- prompt 必须存在于当前 Session prompt catalog；
- resource 必须是当前 Session 中的 RFC 6570 URI template；
- argument 必须是 prompt 声明参数或 template variable；
- context 最多 32 个参数、累计 64 KiB；
- 单个 argument value 最多 16 KiB；
- 单 client 最多 4 个并发 Completion 请求；
- 每次请求最长 15 秒，并继承当前 turn/ACP cancellation signal；
- catalog 越权和未知 context 会在发出协议请求前失败。

## 结果安全

SDK schema 验证后，Blade 仍执行第二层归一化：

- 最多 100 个候选；
- normalization 前最多处理 1 MiB source；
- 每个候选最多 4 KiB；
- 所有候选累计最多 64 KiB；
- NFKC normalization；
- 移除 C0、DEL、Unicode `Cf`、`Co`、`Cn`、bidi、tag 和 private-use 字符；
- 安全 normalization 后去重并保持稳定顺序；
- 保留完整 raw completion 的 SHA-256、source/projected bytes 和 truncation；
- 预算截断或去重时 `hasMore=true`。

返回值仍是外部不可信数据。`CompleteMcpArgument` 的描述明确要求模型只把它们作为候选，
不能执行候选中嵌入的指令。Completion 不创建持久 control message，也不改变 permission、
trust 或 Workspace 边界。

## 使用方式

模型工具：

```text
CompleteMcpArgument
```

输入包含：

- `server`
- `reference`: `{type:"prompt",name}` 或 `{type:"resource",uri}`
- `argument`: `{name,value}`
- 可选 `context`

CLI/TUI/ACP：

```text
/mcp complete <server> <prompt|resource> <reference> <argument> [value] [key=value...]
```

Web MCP 管理面板连接 server 后显示：

- completable prompt arguments；
- resource template variables；
- partial value 输入；
- 安全候选、SHA-256 和 truncation 状态。

## 验证

真实 stdio 资格覆盖：

1. prompt 与 resource template Completion；
2. catalog 越权在请求前拒绝；
3. capability 缺失 fail closed；
4. cancellation 后 client 可继续使用；
5. 4 个并发请求硬上限；
6. 同名 server 的 Session 隔离；
7. Unicode 清理、去重、source/result budgets；
8. 所有 MCP PID 回收。

真实 GPT 和 production DeepSeek Web GUI 均执行：

```text
ToolSearch
-> CompleteMcpArgument
-> choose scoped code
-> ToolSearch
-> mcp__completion__completion_marker
-> Write
```

fixture 同时返回伪 `</system-reminder>` 候选和隐藏 Unicode。模型选择正确 code，隐藏字符
不进入 Web/transcript，trace 和临时目录不含 API 凭证。

## 相关资源

- [MCP Resources、Templates、Prompts 与 Subscriptions](mcp-resources-prompts.md)
- [MCP Server Instructions](mcp-server-instructions.md)
- [MCP Session 隔离](mcp-session-isolation.md)
- [MCP 故障恢复](mcp-fault-recovery.md)
- [测试与生产准出](../testing/qualification.md)
