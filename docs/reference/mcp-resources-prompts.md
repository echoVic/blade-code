# MCP Resources、Prompts 与订阅

Blade 在 Session 私有 MCP 连接上支持 Resources、Resource Templates、Prompts
和 Resource Subscriptions。目录状态、读取和通知不会经过进程级全局 registry。

## 模型工具

MCP content 能力通过 deferred builtin tools 暴露，模型先使用 `ToolSearch` 加载
所需 schema：

| 工具 | 说明 |
|------|------|
| `ListMcpResources` | 列出当前 Session 的资源 |
| `ListMcpResourceTemplates` | 列出参数化资源模板 |
| `ReadMcpResource` | 按 server 和 URI 读取资源 |
| `ListMcpPrompts` | 列出 prompt 和参数定义 |
| `GetMcpPrompt` | 校验参数并解析 prompt |
| `ManageMcpResourceSubscription` | 显式订阅或退订资源更新 |

资源、模板和 prompt 列表都执行完整分页，不依赖启动时的一页缓存。

## 用户命令

活动 Session 提供以下命令：

```text
/mcp resources [server]
/mcp prompts [server]
/mcp prompt <server> <name> [key=value...]
```

TUI 会把解析后的 prompt 作为展开命令交给 Agent，ACP 返回完整的角色化 prompt
内容。Headless Agent 可使用相同的 deferred tools；在 Session 建立前直接执行
`/mcp resources|prompts|prompt` 会 fail closed，不会创建进程级 MCP 连接。

## Catalog 生命周期

连接建立后，Blade 读取 resources、resource templates 和 prompts 的完整目录。
`notifications/resources/list_changed` 与 `notifications/prompts/list_changed`
同步登记 refresh barrier。Agent 在下一次 provider 请求前等待刷新完成。

每个有效变化发布单调 revision 和 `added`、`removed`、`updated` delta。资源与
模板作为一组获取并在校验完成后提交；失败时保留上一有效 snapshot。短时间内的
重复通知会合并，持续通知不会因三轮刷新上限而丢失。

目录限制：

- 每类最多 100 页、1,000 个条目；
- URI 最多 8,192 字符；
- 名称最多 256 字符；
- 描述最多 16 KiB；
- prompt 最多 64 个参数；
- 每类完整目录最多 4 MiB；
- cursor 和协议 identity 不得重复。

## 资源读取

`ReadMcpResource` 要求 URI 存在于当前 server catalog。一次响应最多 64 个
content parts，保留全部 text parts，不再只返回第一项。

单项 text 最多 1 MiB，完整结果最多 4 MiB。二进制 blob 不会把 base64 写入模型
上下文、事件或 transcript，而是转换为：

```json
{
  "size": 1234,
  "sha256": "...",
  "omitted": true
}
```

MCP 资源属于外部不可信内容。它作为普通 tool result 进入模型上下文，不会被提升为
system message。普通 `tools/call` 的 text、structured content 和 binary 使用独立但
一致的安全投影，见 [MCP Tool Result 安全边界](mcp-tool-result-safety.md)。

## Prompt 解析

`GetMcpPrompt` 只接受 catalog 中存在的 prompt：

- 拒绝未知参数；
- 拒绝缺失的 required 参数；
- 拒绝原型污染参数名；
- 保留 `user` / `assistant` role；
- text 和 embedded resource 使用与资源读取相同的预算；
- image/audio blob 只投影大小和 SHA-256；
- 不保留 server `_meta`、icons 或 annotations。

解析结果仍是普通 tool result，不拥有系统指令权限。

## Completion

`CompleteMcpArgument` 只请求当前 Session catalog 中 prompt 参数或 resource template
变量的候选。输入 context、并发、超时和输出值都有独立预算；候选执行 Unicode
normalization、隐藏字符清理、去重和 SHA-256 provenance。候选不会形成 system/control
message，详见 [MCP Completion](mcp-completion.md)。

## Resource Subscription

订阅必须通过 `ManageMcpResourceSubscription` 显式发起，并要求 server 声明
`resources.subscribe`。每个 Session/server 最多 100 个订阅。

收到 `notifications/resources/updated` 后，Blade 不自动读取或注入新内容，只发送
revision 通知并提示模型重新调用 `ReadMcpResource`。退订允许资源已从 catalog
移除的场景。异常断连时 active 订阅随 transport 释放，desired 订阅会在新连接
取得有效资源目录后恢复；手动断开或 Session dispose 会同时清除两者。

## 端侧事件

- TUI：瞬态 `MCP Content` / `MCP Resource` 工具消息；
- Headless JSONL：`mcp_content_changed` / `mcp_resource_updated`；
- Web：`mcp.content.changed` / `mcp.resource.updated`；
- Subagent Web：`subagent.mcp.content.changed` /
  `subagent.mcp.resource.updated`；
- ACP：`agent_message_chunk` revision 摘要。

事件只进入当前活动视图和下一次 provider boundary，不写入 durable transcript。

## 验证

真实 stdio fixture 覆盖分页、多段资源、blob 摘要、prompt 参数、模板、动态目录、
订阅/退订、resource update 和 PID 回收。真实 GPT 与生产 DeepSeek GUI 均执行：

```text
ToolSearch
  -> ListMcpResources + ReadMcpResource + GetMcpPrompt + Subscribe
  -> MCP catalog mutation
  -> subscribed resource update
  -> re-list + re-read
  -> Write
```

## 相关文档

- [MCP 动态工具目录](mcp-dynamic-catalog.md)
- [MCP Session 隔离](mcp-session-isolation.md)
- [MCP Tool Call 生命周期](mcp-call-lifecycle.md)
- [MCP Completion](mcp-completion.md)
- [MCP 故障恢复](mcp-fault-recovery.md)
- [工具列表](tool-list.md)
