# Durable Pending Interaction Recovery

Blade 将工具执行期间的用户交互作为 Session JSONL 的 durable 状态，而不是仅保存在
CLI/Web/ACP 进程内存中。进程退出、Web server 重启或 ACP `session/load` 后，未回答的
请求仍可恢复。

## 覆盖范围

以下交互进入同一恢复协议：

- 普通工具权限确认；
- `AskUserQuestion` 结构化问题；
- MCP Elicitation；
- MCP Sampling 的单次授权。

Plan 进入/退出和最大回合数提示属于运行控制，不使用本协议。

## 写入顺序

每次交互使用三个单调 JSONL 事件：

1. `interaction_requested`：在任何 UI、ACP reverse request 或 SSE 事件可见前 `fsync`；
2. `interaction_responded`：在原工具 Promise 解除阻塞前 `fsync`；
3. `interaction_recovered`：崩溃恢复已关闭原 tool call，并将用户决定写入 durable
   inbox 后提交。

`interaction_requested` 绑定已持久化的 `toolCallId`。若 tool call 本身未能落盘，
交互不会展示。请求或响应超过 128 KiB 时同样 fail closed。

MCP Elicitation 响应只持久化 `accept` / `decline` / `cancel` action，不保存表单
content。崩溃后需要敏感字段时，MCP server 必须重新发起请求。

## 重启语义

### 未回答请求

- TUI resume 会重新打开原 confirmation/question；
- Web catalog 和 Session SSE 会恢复 `pendingInteraction` 及原问题卡片；
- ACP `session/load` 在创建 Runtime 前重新发送标准 permission request；
- headless/print 无交互入口会明确拒绝请求。

回答先持久化，再清除 pending 状态。

### 已回答但工具未结束

Blade 不会重放可能已经产生副作用的原工具调用。恢复流程：

1. 以原 `toolCallId` 写入带 `interactionRecovery` provenance 的关闭结果；
2. 将用户答案或审批决定写入 Session durable inbox；
3. 新 Runtime 以 pending-only turn 继续，让模型检查当前状态后决定下一步；
4. `interaction_recovered` 记录恢复完成。

普通权限批准不会在崩溃后隐式扩大为 Session 或项目权限。模型若仍需执行原操作，
必须基于当前工作区重新发起。

## 跨端行为

| Surface | 恢复行为 |
| --- | --- |
| CLI/TUI | Session activation 后先恢复交互，再读取 inbox 创建 Runtime |
| Web | fresh load 重放问题；回答后自动启动 pending-only turn |
| ACP | `session/load` 回放问题，回答后无需额外 prompt 自动继续 |
| headless/print | 自动拒绝无法表达的交互，并以 fail-closed 结果继续 |

Fork 不继承父 Session 的 pending interaction。Conversation rewind 会和对应
conversation 后缀一起移除 interaction 事件。

## 准出要求

- 确定性测试证明 request-before-surface、response-before-continue、大小预算、幂等
  recovery、fork/rewind 隔离和 HTTP schema；
- 真实 GPT 从预置的 pending Session 经 Web、ACP 与 TUI 恢复并实际调用 `Write`；
- Production Web GUI 使用真实 DeepSeek 验证 fresh-load 问题卡片、回答、自动继续、
  changed files、fresh reload 不重复提问及零 application console error。
