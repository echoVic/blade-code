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
- Web catalog 会恢复 `pendingInteraction` 的类型与 request ID 摘要，Session SSE 会重放
  完整的原问题卡片；
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

## Pending-resume 恢复边界

Web、ACP 与 TUI 在各自符合恢复范围的 turn 遇到可重试的 Provider 零输出故障时，会使用
同一个纯决策策略。它与模型传输层对单个 physical request 的重试不同：传输层仍由
`PiAIChatService` 管理。Web 仅为非 task-isolated 的 pending-input turn 启用该策略，
等待前一个 run 完整落盘并释放 Agent/Runtime lease 后再建新 run；ACP 会为 pending
input、Goal 和 preflight continuation 投影同一生命周期与硬期限，并在同一个 Session
持有的 Agent/Runtime 上等待前次 prompt 收尾后再次调用 prompt。TUI 由当前挂载的
`PendingResumeCoordinator` 在进程内持有 attempt、deadline、backoff timer 与 wake ownership，
但不新增公开的 SSE/ACP retry payload。失败后的自动 outer retry 仅适用于 pending input，
以及 ACP 尚未确定 work kind 的 preflight；Goal failure 不会自动重新激活。

外层恢复最多执行 4 次，总预算为 120 秒。基础退避从 1 秒开始，指数增长到最多
4 秒，并叠加基于 Session identity 与 attempt 的 ±20% 稳定 jitter；最终延迟仍不超过
4 秒。只有同时满足以下条件才会安排下一次尝试：

- 当前 surface 的 eligible durable work 仍待处理：Web/TUI 是 durable inbox；ACP 自动重试
  pending input，以及尚未确定 work kind 的 preflight；
- failure 是规范化且可重试的 `SessionTaskFailure`；
- 尚未产生非空 assistant content/thinking 或 structured output；
- 尚未出现任何工具 lifecycle，且工具调用计数精确为 0；
- attempt 与 120 秒绝对 deadline 都仍有余量。

缺失、畸形或矛盾的 replay evidence 会 fail closed。只要已有输出或工具执行，Blade
就不会重放整个 pending turn；这避免重复 `Write`、Shell、网络请求或其他副作用。达到
attempt 或时间上限后进入 `exhausted`，不可重试错误进入 `failed`。

该状态只投影有界字段，不保存 Provider 原始错误、请求正文、路径、headers 或
credential。Web SSE 使用 `pending.resume`；ACP 使用
`session_info_update._meta["blade/pendingResume"]`。恢复 payload 只暴露 phase、kind、
attempt、maxAttempts、可选 delay/nextRetryAt，以及规范 failure 的 code/retryable 和
可选 resource；外层 SSE/ACP envelope 仍携带各自的 Session identity 或更新时间。

TUI 只为自动 pending-input recovery 启用该 outer retry。普通用户命令、Goal-only
continuation、preflight exception、取消，以及已有输出或工具生命周期的 turn 均不会自动
重放。`PendingResumeCoordinator` 合并 durable inbox 唤醒并持有有界 timer；中间可重试
失败保持静默，最终失败只显示一次规范化错误。

## 跨端行为

| Surface | 恢复行为 |
| --- | --- |
| CLI/TUI | Session activation 后先恢复交互，再读取 inbox 创建 Runtime；仅对零输出、零工具副作用的 durable pending input 做有界 outer retry |
| Web | fresh load 重放问题；回答后自动启动 pending-only turn，并投影有界 outer recovery 状态 |
| ACP | `session/load` 回放问题，回答后无需额外 prompt 自动继续；pending input 共享 Web 的 retry decision，Goal failure 只投影终态且不自动重试 |
| headless/print | 自动拒绝无法表达的交互，并以 fail-closed 结果继续 |

Fork 不继承父 Session 的 pending interaction。Conversation rewind 会和对应
conversation 后缀一起移除 interaction 事件。

## 准出要求

- 确定性测试证明 request-before-surface、response-before-continue、大小预算、幂等
  recovery、fork/rewind 隔离和 HTTP schema；
- Production Web GUI 使用真实 DeepSeek 和一次注入的 `503`，验证可见问题卡片、
  `retry_scheduled -> recovered`、唯一 `Write`、fresh reload 不重复提问以及零浏览器错误；
- production ACP child 通过 SDK stdio 执行 `session/load`，在一次注入的 `503` 后验证
  attempt 2 恢复、唯一 `Write`、durable acknowledgement、正常 `session/close` 与 EOF；
- raw PTY 启动 production CLI `--resume`，通过真实 Question/Review 键盘交互验证唯一
  `Write`、最终文本、durable acknowledgement 和无 signal/fallback 的正常退出；
- 所有 failure diagnostics 和成功 evidence 都必须有界、结构化且不含 credential、
  prompt、正文、绝对临时路径或原始 Provider 数据。
