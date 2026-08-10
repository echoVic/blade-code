# MCP Elicitation

Blade 支持 MCP `elicitation/create`，允许 Session 私有 MCP server 在工具执行期间请求
结构化非敏感输入，或引导用户完成外部 URL 流程。

## 能力协商

`McpClient` 只声明实际实现的能力：

```json
{
  "elicitation": {
    "form": { "applyDefaults": false },
    "url": {}
  }
}
```

Blade 只声明拥有真实 request handler 的能力。每个 `SessionRuntime` 使用独占
`McpRegistry`，因此 elicitation 不会跨 Session 或 workspace 串答。Roots 和显式
opt-in Sampling 有独立 handler 与安全策略，详情见
[MCP Roots 与 Sampling](mcp-roots-sampling.md)。

MCP tools 默认 deferred。模型先通过 `ToolSearch` 激活工具 schema，再调用工具。
一次 MCP client 只允许一个 interactive tool call；重叠调用直接拒绝，避免协议没有
parent call ID 时错误关联用户响应。

## Form 模式

Blade 支持 MCP schema 中的：

- string，以及 date、date-time、email、URI 格式提示；
- number 和 safe integer；
- boolean；
- string enum、oneOf；
- string enum array 多选；
- required、default、长度、范围和选项数量约束。

请求最多包含 32 个字段、每字段最多 100 个选项。`__proto__`、`constructor` 和
`prototype` 字段名会在渲染前拒绝。提交内容最多 64 KiB，并在发送给 server 前按原始
requested schema 再验证一次；额外字段、错误类型、越界值和不安全整数统一取消。

Form 只适合非敏感数据。API key、支付、OAuth 和其他秘密必须使用 URL 模式，让数据
直接提交给 MCP server，而不是经过 Blade、模型上下文或 Hook。

## URL 模式

Blade 只接受无 username/password 的绝对 HTTP(S) URL：

- TUI 显示 server、域名和完整 URL，用户显式确认后才在本机打开；
- Web 只在真实点击手势中使用 `noopener,noreferrer` 打开；
- ACP 显示完整 URL，由 IDE 用户自行打开，不操作 Agent 宿主浏览器；
- headless 没有交互面时返回 `cancel`。

Blade 接收 `notifications/elicitation/complete` 并发布内部完成事件。工具调用、Session
取消、传输关闭或交互超时都会确定性返回 `cancel`，不会留下悬挂请求。

## 跨端交互

TUI、Web 和 ACP 共用 `ConfirmationHandler` 的 `mcpElicitation` 类型：

- TUI 提供逐字段输入、选择和提交前复核；
- Web 提供可访问的结构化卡片、后台任务注意力状态和 stale-session 精确路由；
- ACP 将 enum、boolean 和 URL 投影为标准 permission choices；
- ACP 无法表达的必填自由文本、数字和多选会 fail closed；带默认值的字段必须由用户
  明确选择使用默认值。

Web Bus 事件只包含 server、message 和 schema，不包含用户填写内容。回答只经过
`/permissions/:id` 返回当前精确 `sessionId + projectPath` 的活动请求，不写入
Session transcript。

## Hooks

新增两个受信任 Hook 事件：

- `Elicitation`：展示 UI 前执行，可返回 accept、decline、cancel 和可选 content；
- `ElicitationResult`：响应发送给 MCP server 前执行，可复核或替换结果。

Hook 返回值仍经过原始 MCP schema 校验。配置型 Hook 受 Hook Trust 摘要保护；Hook
可以看到 form content，因此不要把秘密放进 Form，也不要在 Hook 输出或日志中记录输入。

## 资格证据

- 真实 stdio MCP server 覆盖 Form、URL、completion notification、取消、无 UI、
  非法响应和重叠调用；
- 真实 GPT 通过 ToolSearch 激活 MCP 工具，完成 elicitation 后继续 Write；
- 生产 DeepSeek Web GUI 覆盖 MCP 工具审批、结构化表单、任务注意力、最终回复、
  fresh-tab 恢复和 stdio PID 回收。

## 相关资源

- [MCP Session 隔离](mcp-session-isolation.md)
- [Hooks](../guides/hooks.md)
- [测试与生产准出](../testing/qualification.md)
