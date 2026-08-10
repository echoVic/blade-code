# MCP 故障恢复

Blade 为每个 Session 私有 MCP client 提供有界、可取消的连接恢复。stdio
进程退出、远程 transport 终止、HTTP Session 过期或健康检查失败时，不会继续暴露
旧工具和 content catalog。

## 恢复状态机

每个 client 只有一个连接 generation 和一个恢复任务：

```text
connected
  -> reconnecting (撤销旧目录并拒绝在途调用)
  -> connected + recovered
  -> error + failed
```

- 初始连接和自动恢复均为 single-flight；
- 手动 disconnect、Session dispose 和配置卸载会增加 generation、取消退避并关闭
  在建 transport；
- 迟到的旧 generation 不能发布目录、恢复订阅或覆盖新连接；
- 新 generation 会重新协商当前 Session 的 MCP logging level；
- 旧 generation 的 server instructions 立即撤销，新 instructions 只在完整握手后发布；
- in-flight Completion 不跨 generation 重放，旧 client 返回的候选会被拒绝；
- SDK transport close 会拒绝全部 pending requests，在途 `tools/call` 不会永久挂起；
- reconnect timer 使用 `unref()`，不会阻止 CLI 或 headless 进程退出。

连接关闭后，Blade 先原子移除该 server 的 tools、resources、templates 和 prompts，
再进入退避。恢复连接只有在完整目录通过校验后才重新发布。模型因此不会调用仍指向
死亡 transport 的旧工具。

## 故障识别

以下信号进入统一恢复状态机：

- stdio / SSE / Streamable HTTP 的 `onclose`；
- `ECONNRESET`、`EPIPE`、`ETIMEDOUT`、SSE reconnect exhausted 等连续终端错误；
- HTTP 404 / JSON-RPC session-not-found；
- MCP `ping` 连续失败达到健康检查阈值。

普通协议校验或 notification handler 错误不会立即重启 transport。远程 transport
中间错误达到阈值后才强制 close，使 SDK 拒绝 pending requests 并建立新 Session。

## 配置

自动恢复默认启用：

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "recovery": {
        "enabled": true,
        "maxAttempts": 5,
        "initialDelayMs": 1000,
        "maxDelayMs": 30000,
        "jitterRatio": 0.2,
        "terminalErrorThreshold": 3
      },
      "healthCheck": {
        "enabled": true,
        "interval": 30000,
        "timeout": 10000,
        "failureThreshold": 3
      }
    }
  }
}
```

边界：

- `maxAttempts`：0–20；0 或 `enabled: false` 表示撤销目录后不自动重连；
- `initialDelayMs` / `maxDelayMs`：10 ms–5 分钟，指数退避受 max 限制；
- `jitterRatio`：0–1，默认 20% 对称 jitter；
- `terminalErrorThreshold`：1–10；
- health interval：10 ms–5 分钟；
- health timeout：10 ms–1 分钟；
- health failure threshold：1–10。

非法值在创建 client 时 fail closed，不会产生零延迟 crash loop。

## 健康检查

健康检查调用协议 `ping`，不再把缓存中的 tools 或 server info 当作连接存活证据。
ping 使用 SDK timeout、AbortSignal 和 hard total timeout。达到阈值后只向统一恢复
状态机提交 `health_check`，不会并行执行另一套 disconnect/connect。

## Resource Subscription

订阅状态分为 desired 与 active：

- 用户显式 subscribe 写入 desired；
- transport 关闭只清空 active；
- 新连接取得资源目录后，对仍存在且 server 支持 subscribe 的 URI 自动恢复；
- 动态目录移除资源会撤销 active，资源重新出现时再次订阅；
- 手动 unsubscribe 或 Session dispose 同时清除 desired 和 active。

每个 server 仍受 100 个 Session 私有订阅上限约束。

## Async Task Recovery

显式启用的 MCP Tasks 在 transport 关闭时进入 `interrupted`，不会丢失 Blade
`mcp_task_*` ownership。新 generation 连接后重新执行 `tasks/get`，并同时校验原始
task ID 与 `createdAt`；身份变化会 fail closed。`tasks/result` 取结果期间断流也会在
剩余 local lifetime 内恢复并重试。Session dispose 或显式 disconnect 则取消任务，
不会在后台继续恢复。详见 [MCP Async Tasks](mcp-tasks.md)。

## 可观测性

连接事件包含单调 revision、server、phase、reason、attempt、maxAttempts 和可选
nextRetryAt。错误会移除 URL、Bearer/API key，并限制为 512 bytes。

- TUI：`MCP Connection` 完成态通知；
- Headless JSONL：`mcp_connection_changed`；
- Web：`mcp.connection.changed`；
- Subagent Web：`subagent.mcp.connection.changed`；
- ACP：`agent_message_chunk` 状态摘要；
- Web MCP 管理面板：`Recovering n/m`，Disconnect 可取消恢复。

事件在 provider boundary 注入瞬态控制消息，不进入 durable transcript。错误文本只供
用户诊断，不注入模型控制消息，避免恶意 transport error 形成 prompt injection。

## 验证

真实 stdio fixture 在 `tools/call` 中退出首代进程，验证：

1. pending call 收到 `Connection closed`；
2. 旧 tools/content revision 被原子撤销；
3. 第二代进程发布不同目录；
4. desired resource subscription 自动恢复；
5. 手动 disconnect 可取消尚未执行的退避；
6. Session dispose 回收全部 PID、timer 和 transport。

真实 GPT 和生产 DeepSeek Web GUI 均完成：

```text
subscribe + read
  -> MCP process crash
  -> reconnecting / catalog removal
  -> bounded recovery / subscription restore
  -> recovered / ToolSearch
  -> recovered tool + resource read
  -> Write
```

## 相关资源

- [MCP Session 隔离](mcp-session-isolation.md)
- [MCP 动态工具目录](mcp-dynamic-catalog.md)
- [MCP Resources、Prompts 与订阅](mcp-resources-prompts.md)
- [MCP Tool Call 生命周期](mcp-call-lifecycle.md)
- [MCP Logging 与诊断](mcp-logging.md)
- [MCP Server Instructions](mcp-server-instructions.md)
- [MCP Completion](mcp-completion.md)
- [MCP Async Tasks](mcp-tasks.md)
- [测试与生产准出](../testing/qualification.md)
