# MCP Tool Call 生命周期

Blade 将每次 MCP `tools/call` 绑定到当前 Agent tool call，统一处理 Session 取消、
idle timeout、hard total timeout 和 `notifications/progress`。

## 取消与超时

`ExecutionContext.signal` 会直接传入 MCP SDK。用户停止任务、Session dispose 或
streaming epoch discard 时：

1. SDK 终止本地 pending request；
2. 向支持 cancellation 的 MCP server 发送协议取消；
3. Blade 将 SDK 的 timeout 包装恢复为 `AbortError`，避免把用户取消误报为超时；
4. ToolExecutor 生成可恢复的中断结果，不让迟到响应进入下一轮模型上下文。

每个 server 可配置：

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "timeout": 300000,
      "idleTimeout": 60000
    }
  }
}
```

- `timeout`：完整 tool call 的 hard total timeout，默认 5 分钟；
- `idleTimeout`：无响应或 progress 的 idle timeout，默认 1 分钟；
- progress 会刷新 idle timeout，但不能突破 hard total timeout；
- 两者范围均为 1 秒到 30 分钟，且 `idleTimeout <= timeout`；
- Blade 同时使用 SDK `maxTotalTimeout` 和独立 AbortController，防止断流 transport
  留下永久 pending promise。

## Progress

Blade 为 MCP call 请求 progress token，并校验 server 返回的进度：

- `progress` 必须是非负有限数；
- `total` 必须是正有限数；
- progress 不能倒退；
- 每次调用最多接收 128 条进度；
- message 移除空字节并截断到 1000 字符；
- Agent Loop 的待投影队列最多保留 256 条，防止 UI 消费慢导致无界内存增长。

进度通过统一 `tool_progress` LoopEvent 投影：

- TUI 显示带 tool-call identity 的瞬态工具进度；
- Web 在折叠工具组直接显示 message、百分比和可访问 progressbar；
- headless JSONL 输出 `tool_progress`；
- ACP 输出标准 `tool_call_update`，状态保持 `in_progress`；
- subagent progress 使用独立 child session/tool-call identity，不污染父工具。

Progress 不写入模型 transcript 或 durable conversation。最终 `tool_result` 仍是唯一进入
下一轮模型上下文的 MCP 结果。

## 资格证据

- 真实 stdio MCP server 覆盖 progress token、顺序进度、parent abort、idle heartbeat、
  hard timeout 和 PID 回收；
- 确定性测试覆盖配置边界、非法/倒退/过量 progress、Loop 顺序以及
  TUI/Web/headless/ACP 投影；
- 真实 GPT 完成 ToolSearch → progressive MCP → Write，并捕获 MCP 与内置 Write
  progress；
- 生产 DeepSeek Web GUI 在折叠工具组显示 `phase-one · 33%`，随后完成最终回复和
  fresh-tab 恢复，任务终态无 MCP 残留进程。

## 相关资源

- [MCP Session 隔离](mcp-session-isolation.md)
- [MCP Tool Result 安全边界](mcp-tool-result-safety.md)
- [MCP Roots 与 Sampling](mcp-roots-sampling.md)
- [工具并发模型](tool-concurrency.md)
- [测试与生产准出](../testing/qualification.md)
