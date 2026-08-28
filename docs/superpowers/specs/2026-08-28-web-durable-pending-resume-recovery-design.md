# Web Durable Pending-Resume Recovery Design

> 状态：批准实施
> 日期：2026-08-28

## 背景

Blade 已在 ACP 中为 durable pending input 提供单飞、有界退避和硬恢复时限，
但 Web 冷恢复仍把一次 Provider 恢复预算耗尽视为终态失败。真实故障轨迹证明：
当 Provider 尚未产生内容、思考、structured output 或工具证据时，durable inbox
仍保留同一条未消费输入，Web 却停止推进，直到用户重新连接或再次触发唤醒。

本 patch 将 ACP 已验证的安全决策抽成 surface-neutral policy，并让 Web Session
控制器在严格的零副作用边界内继续恢复。它不扩大 Provider 内部重试，不自动重放
普通用户消息、Goal continuation 或 task-isolated run，也不引入常驻 supervisor。

## 目标与非目标

### 目标

1. Web durable pending input 在规范化瞬态失败后自动进行有界外层恢复。
2. 只有 inbox 仍待处理且本次尝试没有任何输出或工具证据时才能重试。
3. 同一 Session 同时最多有一个恢复状态机；重复 SSE、Team 或 subagent 唤醒不产生
   并发重放。
4. 恢复最多四次，总时限 120 秒；退避带稳定抖动并响应取消。
5. 每次新尝试必须等待前一次 Agent 销毁和 Runtime lease 释放。
6. Web SSE 投影有界的 scheduled/recovered/failed/exhausted 生命周期，并避免同一
   durable user input 在 GUI 中重复出现。
7. Session 删除、用户新消息、显式 abort、controller replacement 和 server shutdown
   都清除 timer、拒绝 pending permission，并阻止晚到成功提交。
8. ACP 改为复用同一纯策略，保持现有协议行为。

### 非目标

- 不重试普通用户发起的 turn、Goal continuation、task-isolated worker 或需要人工确认的
  uncertain turn recovery。
- 不在已有 content/thinking/structured output/tool start/progress/result 后重放。
- 不改变 Provider 内部 retry、fallback、circuit breaker 或请求时限。
- 不把网络/Provider stall 当作 Goal 语义停滞，也不启动 planner/strategist。
- 不修改 durable inbox 格式、Task 状态协议或当前 Goal frontier schema。

## 方案选择

### 采用：共享纯决策 + surface 自有编排

`PendingResumeRecoveryPolicy` 只接收 canonical failure、尝试次数、时间、pending 状态和
副作用证据，返回 `retry_scheduled | failed | exhausted` 及稳定 delay。ACP 和 Web 分别
持有 timer、generation、permission、Runtime lease 与投影。

这一方案复用安全规则，但不强行把 ACP request/response 生命周期和 Web run/SSE 生命周期
塞进同一个状态机。它也让纯函数可以穷举测试，而 controller 测试集中验证所有权和清理。

### 未采用：复制 ACP 实现到 Web

复制常量和判定短期改动更小，但两个入口会继续漂移；新增边界时容易出现一个 surface
允许重放、另一个拒绝重放的安全差异。

### 未采用：把恢复下沉到 Provider 层

Provider 不知道 durable inbox 是否仍待处理，也不知道 Web 是否已经投影内容、工具或
permission。下沉会丢失 exactly-once 所需的 surface 与 Runtime 证据。

## 共享恢复策略

新增 `packages/cli/src/agent/runtime/PendingResumeRecoveryPolicy.ts`：

```ts
interface PendingResumeFailureEvidence {
  taskFailure: SessionTaskFailure;
  outputStarted: boolean;
  toolExecutionStarted: boolean;
  toolCallsCount: number;
}

type PendingResumeRetryPhase =
  | 'retry_scheduled'
  | 'failed'
  | 'exhausted';
```

重试必须同时满足：

- durable work 仍 pending；
- `taskFailure.retryable === true`；
- `outputStarted === false`；
- `toolExecutionStarted === false`；
- `toolCallsCount === 0`；
- 当前失败尝试小于 4；
- `elapsed + delay <= 120_000ms`。

delay 以 `workspace identity + Session ID + failed attempt` 计算稳定 SHA-256 抖动，
基础退避为 1s、2s、4s，单次上限 4s，抖动范围为正负 20%。未知或不完整证据一律
fail closed。

## 规范化错误边界

`toTaskFailure` 必须识别错误链中稳定的 Provider code：

- `PROVIDER_RECOVERY_BUDGET_EXCEEDED`；
- `PROVIDER_REQUEST_DEADLINE_EXCEEDED`；
- `STREAM_IDLE_TIMEOUT`。

它们统一映射为 canonical `timeout`，不得持久化 Provider 原始消息、路径或 credential。
错误链遍历有固定深度、循环保护和 hostile object 防护；已有 canonical
`SessionTaskFailure` 投影保持幂等。

## Web 状态机

Web controller 以规范化 `projectPath + sessionId` 为 key 保存：

- `attempt`；
- `startedAt` 与 `deadlineAt`；
- 单调 `generation`；
- `inFlight` 和一个 timer；
- 已投影 recovered input message ID 集合。

首次冷恢复或 idle wake 建立 generation。只有 `pendingInputOnly` 的非 task-isolated
run 会绑定该状态。`executeRunAsync` 记录四类 replay boundary：

1. 非空 `content_delta`；
2. 非空 `thinking_delta` 或任意 `structured_output`；
3. `tool_start` / `tool_progress` / `tool_result`；
4. LoopResult 的 `toolCallsCount`。

失败时 controller 先用 canonical failure 构造证据，再询问共享 policy。若允许重试：

1. 当前 run 标为已结束但 Session 保持 running，不发 `session.error`；
2. 发 `pending.resume` 的 `retry_scheduled`；
3. timer 到期后先等待旧 `run.completion`，确保 Agent destroy 与 lease release 完成；
4. 在相同 Session submission lock 内启动下一次 pending-only run；
5. `follow_up_started` 通过 message ID 集合避免重复投影同一 durable input。

成功后发 `recovered` 并清理状态。不可重试发 `failed`；预算耗尽发 `exhausted`，随后
保持现有 canonical `session.error`。任何 generation 不匹配的 timer 或晚到结果都被忽略。

## 硬时限与清理

每个 Web 恢复 run 都继承同一 120 秒 deadline，而不是每次重置。deadline 到达时：

- abort 当前 run；
- 以 `__aborted__` 拒绝未决 permission，解除等待；
- 把失败归一化为 `timeout/exhausted`；
- 不接受随后返回的 late success；
- 不发 `session.completed`。

以下动作立即使 generation 失效并清理 timer：新用户 message、显式 abort、Session 删除、
controller reset/replacement 和 shutdown。清理是幂等的。

## 跨端投影

- Web SSE：`pending.resume` 只包含 phase、kind、attempt、maxAttempts、可选 delay/
  nextRetryAt，以及 canonical failure code/retryable。
- Web store：复用 Provider recovery 的短状态展示；`recovered` 或终态清空，不保存原始
  Provider 错误。
- ACP：保持现有 `blade/pendingResume` metadata，但常量、delay 和判定由共享 policy 提供。
- CLI TUI：本 patch 不新增自动重放；CLI 仍由 `PendingResumeCoordinator` 负责合并唤醒。
  其现有真实 API PTY 轨迹作为无回归门禁。

## 测试与准出

### 确定性测试

- policy：稳定抖动、四次/120 秒边界、pending 条件，以及每个输出/工具边界 fail closed；
- task failure：三种稳定 Provider timeout code、嵌套错误链、循环和 hostile object；
- Web controller：零副作用失败重试并恢复、等待前一 run settle、重复唤醒单飞、message ID
  去重、hard deadline、非重试错误、六类 replay boundary、abort/delete/shutdown 清理；
- ACP：复用 shared policy 后现有 pending-resume 生命周期保持一致；
- Web store：scheduled/recovered/failed/exhausted 状态有界且 Session identity 隔离。

### 真实 API 与 GUI

使用现有 production qualification harness：

1. 通过本地 recording proxy 对 Web 冷恢复首次请求注入一次 `503`；
2. 下一次真实 Provider 请求再经历真实或受控 idle timeout；
3. 后续真实 GPT 或 DeepSeek 完成唯一一次 Write 和最终回复；
4. production Chromium 通过真实 GUI 回答 durable question 并 reload；
5. 断言一个 request/response/recovery、一个 Write call/result、一个 final assistant、inbox
   已确认、目标字节精确、零 credential 泄露、零 console/network 错误；
6. raw PTY TUI 与 ACP 现有真实 API 轨迹必须保持通过。

发布门禁为 `bun run build`、`bun run type-check`、`bun run lint`、完整 deterministic
suite、Web tests、真实 API qualification 的相关轨迹和 production Chromium GUI。作为独立
稳定性修复发布一个 patch 版本；不混入当前工作区其他未提交改动。
