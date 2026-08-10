# MCP 动态工具目录

Blade 支持 MCP server 在 Session 运行期间通过
`notifications/tools/list_changed` 更新工具目录。更新在 server、Session 和
Agent executor 三层保持原子性，模型不会看到半刷新状态。

## 稳定工具身份

MCP transport 使用 server 声明的原始工具名。模型、权限系统、工具白名单和
`ToolSearch` 使用稳定的 provider 名称：

```text
mcp__<server>__<tool>
```

server 和 tool 片段会被规范化；不安全或过长的片段带有 SHA-256 摘要后缀。
不同 server 的同名工具不会冲突，MCP 工具也不能覆盖 Blade 内置工具。

## 刷新协议

1. 连接建立后，`McpClient` 分页读取完整的 `tools/list`。
2. `list_changed` 通知同步登记一个刷新 barrier；短时间内的重复通知会合并。
3. Agent 在下一次 provider 请求前等待 barrier。
4. 完整目录通过校验后，`McpRegistry` 发布单调递增的 revision 和
   `added`、`removed`、`updated` delta。
5. Session 中的基础 registry 和所有活动 executor 一次替换完整 MCP 投影。
6. 新增工具保持 deferred，必须通过 `ToolSearch` 加载 schema；未变化且已经
   加载的工具保留 loaded 状态。

catalog 变化会作为瞬态控制消息进入下一次 provider 请求，但不会写入持久会话
历史。

## 边界

每个 server 的目录刷新受以下限制：

- 最多 100 页；
- 最多 1,000 个工具；
- 单个工具名最多 256 个字符；
- 单个描述最多 16 KiB；
- 单个 input schema 最多 256 KiB；
- 完整目录最多 4 MiB；
- cursor 不得重复；
- 原始工具名和 provider 工具名均不得重复。

任何分页、schema、大小或命名校验失败都会整体拒绝新目录。上一有效 revision
继续服务，现有 MCP 连接保持可用，并发出 `catalogRefreshFailed` 诊断事件。

## Session 隔离

Session 只投影其不可变 MCP server 快照。Agent 的 `toolWhitelist` 和
`toolBlacklist` 会在每个 revision 重新应用，因此 catalog delta 也只包含该
executor 可见的工具。子 Agent、CLI、Web 和 ACP 不共享可变的全局工具目录。

executor 销毁时会解除 catalog 订阅。Session 销毁时先解除订阅，再关闭 MCP
client 和 transport，防止断连事件写入已释放的 registry。

## 端侧事件

- TUI：显示瞬态 `MCP Catalog` 工具消息；
- Headless JSONL：发送 `mcp_catalog_changed`；
- Web：发送 `mcp.catalog.changed`，子 Agent 使用
  `subagent.mcp.catalog.changed`；
- ACP：发送 `agent_message_chunk` catalog 摘要。

这些事件包含 revision、server 名称和 added/removed/updated provider 名称。

## 验证

确定性 stdio fixture 覆盖分页、通知合并、add/update/remove delta、无效重复
目录回滚、工具调用和进程回收。真实 API 资格覆盖：

```text
ToolSearch
  -> mcp__dynamic__unlock_catalog
  -> list_changed / revision barrier
  -> ToolSearch
  -> mcp__dynamic__dynamic_marker
  -> Write
```

生产 Web GUI 使用 DeepSeek 执行相同轨迹，并检查 catalog 卡片、最终文件、
浏览器控制台、MCP trace 和 PID 回收。

## 相关文档

- [MCP Session 隔离](mcp-session-isolation.md)
- [MCP Tool Call 生命周期](mcp-call-lifecycle.md)
- [MCP 故障恢复](mcp-fault-recovery.md)
- [MCP OAuth 生命周期](mcp-oauth-lifecycle.md)
- [工具列表](tool-list.md)
