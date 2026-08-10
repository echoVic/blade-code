# MCP Async Tasks

Blade 支持 MCP SDK 的实验性 Tasks 协议，用于把 task-capable `tools/call` 映射为
Session 私有后台任务。该能力默认关闭；只有 server 配置显式启用后才能创建任务。

## 执行语义

MCP tool catalog 中的 `execution.taskSupport` 决定调用方式：

- `required`：动态 `mcp__<server>__<tool>` 调用自动创建后台任务；
- `optional`：普通动态工具调用保持前台同步，模型可显式调用 `StartMcpTask`；
- `forbidden` 或未声明：不能通过 Tasks 路径执行。

任务创建只返回 Blade 生成的 `mcp_task_<uuid>`。原始 server task ID 仅保存在
Session runtime 内部，不进入模型、Web、TUI、ACP、headless 或 slash command 输出。

```text
task-capable tools/call
  -> opaque mcp_task_* ID
  -> tasks/get polling
  -> TaskOutput
  -> normalized MCP tool result
```

`TaskOutput` 是 shell、subagent 和 MCP 后台任务共用的读取入口。`ListMcpTasks` 只列出
当前 Session 已创建的任务；Blade 不采用 `tasks/list` 返回的任意 server task。
`CancelMcpTask` 先请求 `tasks/cancel`，再无条件终止本地 watcher。

## 配置

每个 server 独立启用：

```json
{
  "mcpServers": {
    "build": {
      "type": "stdio",
      "command": "build-mcp",
      "tasks": {
        "enabled": true,
        "defaultTtlMs": 600000,
        "pollIntervalMs": 500,
        "maxTasksPerSession": 8,
        "maxLifetimeMs": 1800000
      }
    }
  }
}
```

边界：

- `enabled` 必须显式为 `true`；
- TTL 和 local lifetime 为 10 秒至 24 小时；
- `defaultTtlMs` 不能超过 `maxLifetimeMs`；
- poll interval 为 100 ms 至 10 秒，恶意 server 值会被 clamp；
- 每个 Session 最多 32 个任务，每个进程最多 256 个；
- 任务超过 local lifetime 后会取消并标记失败。

## Session 与连接安全

任务 ownership 同时绑定 Session ID 和 canonical execution workspace。跨 Session、
跨 workspace 或伪造的 task ID 均 fail closed。Session dispose、server unregister、
disconnect 和 reconnect 前会取消对应任务并清理 watcher。

意外 transport 关闭时，任务进入 `interrupted`：

1. 等待该 Session client 的 generation-fenced 有界恢复；
2. 在新连接重新调用 `tasks/get`；
3. 校验原始 task ID 与 `createdAt` 未变化；
4. `tasks/result` 自身断流时同样恢复并重试；
5. lifetime 到期或身份变化时 fail closed。

`input_required` 通过标准 `tasks/result` side channel 交付关联的 Elicitation 或
Sampling 请求。请求继续使用原始 Session interaction handler：Sampling 默认关闭且
逐次审批，Elicitation 受当前 TUI/Web/ACP 表达能力和 cancellation 约束。

## 结果安全

Task result 复用 [MCP Tool Result 安全边界](mcp-tool-result-safety.md)：

- text、structured content 和 binary 使用共享硬预算；
- `_meta` 不进入模型；
- 大结果转为 Session 私有 0600 artifact；
- ACP remote 只得到 opaque artifact ID；
- error、status message 和 reconnect 文本执行 NFKC、隐藏 Unicode 清理、凭证/URL
  脱敏与 1 KiB 上限；
- status message 只用于用户诊断，不能授权操作，也不作为模型指令注入。

## 交互入口

模型工具：

```text
StartMcpTask
ListMcpTasks
CancelMcpTask
TaskOutput
```

CLI/TUI/ACP：

```text
/mcp tasks [server]
/mcp task <mcp_task_*>
/mcp task-cancel <mcp_task_*>
```

生命周期统一投影到：

- TUI `MCP Task` 卡片；
- headless `mcp_task_changed`；
- Web `mcp.task.changed`，同一卡片从 running 更新到 terminal；
- subagent Web `subagent.mcp.task.changed`；
- ACP `agent_message_chunk`。

Web MCP 面板显示每个 server 的 opt-in 状态、Session 上限和 poll interval。

## 验证

真实 stdio 资格覆盖 required/optional/disabled、显式后台化、ownership、取消、
Session dispose、`tasks/get` 和 `tasks/result` 两种断流恢复、generation identity、
Unicode 清理、result metadata 脱敏及全部 PID 回收。

真实 GPT 与 production DeepSeek Web GUI 均完成：

```text
ToolSearch
-> required MCP task
-> opaque mcp_task_*
-> TaskOutput
-> Write
```

GUI 还验证了运行态卡片原地更新为 completed、MCP 面板 opt-in 参数和 production
构建；原始 server task ID、Bearer metadata 和宿主路径均未进入模型或页面。

## 相关资源

- [MCP Tool Call 生命周期](mcp-call-lifecycle.md)
- [MCP Tool Result 安全边界](mcp-tool-result-safety.md)
- [MCP 故障恢复](mcp-fault-recovery.md)
- [MCP Session 隔离](mcp-session-isolation.md)
- [测试与生产准出](../testing/qualification.md)
