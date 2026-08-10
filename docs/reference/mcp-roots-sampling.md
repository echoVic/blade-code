# MCP Roots 与 Sampling

Blade 支持 MCP `roots/list`，并提供默认关闭、显式授权的基础
`sampling/createMessage`。两项能力均绑定单个 `SessionRuntime`，不会使用进程全局
workspace 或模型状态。

## Session Roots

每个 MCP client 都声明 `roots` 并注册真实 request handler。返回值是 Session 创建时
冻结的执行 workspace：

- 普通 CLI 和 Web Session 返回当前 workspace；
- 独立 task 返回 task worktree，而不是 source project；
- URI 通过 canonical realpath 和 `pathToFileURL` 生成；
- ACP remote Session 返回空 roots，避免把 Agent 宿主路径冒充 IDE 远端文件系统；
- roots 在 Session 生命周期内不可变，因此 `listChanged` 为 `false`。

MCP 配置身份和 stdio 默认 cwd 仍来自 source project。roots 表示工具应操作的执行路径，
两者不能混用。

## Sampling 配置

Sampling 默认不声明。每个 server 必须显式启用：

```json
{
  "mcpServers": {
    "review": {
      "type": "stdio",
      "command": "review-mcp",
      "sampling": {
        "enabled": true,
        "maxTokens": 1024,
        "maxRequestsPerToolCall": 2,
        "maxInputBytes": 65536
      }
    }
  }
}
```

| 配置 | 默认值 | 硬上限 |
|------|--------|--------|
| `maxTokens` | 1024 | 4096 |
| `maxRequestsPerToolCall` | 2 | 8 |
| `maxInputBytes` | 64 KiB | 1 MiB |

项目级配置受 Workspace Trust 保护。配置无效时 Session 创建 fail closed；没有
Session sampling adapter 的旧连接即使配置启用也不会声明能力。

## 支持边界

Blade 声明基础 Sampling，不声明 context 或 tools 扩展：

- 支持 text 和 JPEG、PNG、GIF、WebP image 输入；
- 图片计入 server 的 `maxInputBytes`，并复用 20 张、合计 5 MiB 的共享 attachment
  budget；
- 使用当前 Session 冻结的模型、provider 和凭据；
- server 的 model hints 不能切换模型，凭据不会返回 server；
- 每次请求可收紧 output tokens 和 temperature；
- stop sequences 在响应发送前本地截断；
- tools、`includeContext`、audio、task sampling 和其他 content blocks 统一拒绝。

同一 MCP tool call 可以顺序请求多次 Sampling，但不能重叠。请求次数、输入字节、输出
token 和响应字节都有限制；父工具取消、超时、传输关闭或 Session dispose 会中止
嵌套模型请求。

## Human-in-the-loop

MCP 规范要求 Sampling 前通知用户。Blade 对每次请求强制逐次批准：

- TUI 只显示“允许本次/拒绝”，不提供 Session 或 project 记忆；
- Web 显示 server、token 上限和 system/user 预览，同样只允许一次；
- ACP 即使在 yolo mode 也发出标准 one-shot permission request；
- headless 没有交互面时 fail closed。

批准 scope 不进入普通工具 approval store。server 不能通过先获得 MCP tool 的持久权限
来绕过后续 Sampling 审批。

## 资格证据

- 真实 stdio MCP server 主动调用 `roots/list` 和 `sampling/createMessage`；
- 确定性测试覆盖 URI 编码、ACP 空 roots、能力协商、配置边界、text/image、
  unsupported content、请求次数、重叠调用和 parent abort；
- 真实 GPT 完成 ToolSearch → MCP tool → nested sampling → Write，并验证 stdio PID
  回收；
- 生产 DeepSeek Web GUI 覆盖普通 MCP 工具审批、Sampling 单次审批、请求预览、
  token 上限、最终回复、fresh-tab 恢复和零 Blade 应用错误。

## 相关资源

- [MCP Session 隔离](mcp-session-isolation.md)
- [MCP Tool Call 生命周期](mcp-call-lifecycle.md)
- [MCP Elicitation](mcp-elicitation.md)
- [Workspace 模型与 Provider 隔离](workspace-model-resources.md)
- [测试与生产准出](../testing/qualification.md)
