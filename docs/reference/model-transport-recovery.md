# 模型传输恢复

Blade Code 在 `PiAIChatService` 中统一拥有模型请求的重试策略。pi-ai provider 的自动重试固定为 `0`，避免 provider 与 Agent 各自重试导致请求次数相乘，也避免底层在 Blade 不知情时重放流式响应。

## 可重试错误

Blade 会遍历 `lastError` 和 `cause` 错误链，并把以下错误视为瞬时故障：

- HTTP `408`、`409`、`429` 和 `5xx`；
- 连接超时、DNS 暂时失败、连接重置或拒绝、socket 中断等网络错误；
- 网关明确返回的 `upstream_error` 或 `temporarily unavailable`；
- 错误消息或结构化字段中携带的同类状态和错误码。

`maxRetries` 表示首次请求之后最多追加的尝试次数。重试使用有界指数退避，等待期间响应当前 turn 的 `AbortSignal`，取消后不会再启动新请求。

真实 API 协议测试使用与产品一致的默认重试次数，不再强制 `maxRetries: 0`。因此资格
结果同时验证协议兼容性和生产恢复策略；首个对外 chunk 之后仍受下述重放边界约束。

上下文超限属于确定性错误。`prompt_too_long`、`maximum context length`、`context_length_exceeded` 等标记即使被网关包装成 HTTP `500`，也不会进入传输重试或模型 fallback，而是返回 Agent loop 触发反应式压缩。

## 前台长任务恢复

root foreground turn 在没有显式模型 `overrides.maxRetries` 时，默认最多追加 12 次
请求，并由 `providerForegroundRecoveryMs` 同时限制首个瞬时故障后的总恢复时间：

- 默认恢复预算 `600000ms`（10 分钟）；
- `0` 禁用扩展恢复；
- 其他值必须是 `30000-3600000ms` 的整数；
- 显式 `overrides.maxRetries` 始终优先，`0` 仍表示不重试；
- primary 与 fallback 共享同一个恢复起点和绝对 deadline；默认策略还共享 12 次追加
  尝试上限，显式 `maxRetries` 保留既有的 per-candidate 语义；
- 扩展退避单次最多 60 秒，长等待每 15 秒产生一次 `waiting` heartbeat；
- backoff 和 in-flight retry 都响应 Esc、ACP cancel、Web stop、Headless signal 与
  coordinated shutdown。

恢复时钟从第一个可安全重放的瞬时错误开始，不包含初次正常请求耗时。开始恢复后，
等待、建连和模型 stream 都计入同一预算。deadline 到达会中止当前 pi-ai iterator，
清理 hard timer，并投影一次 typed `exhausted/recovery_budget`。

background subagent、verification、compaction、provider health、标题生成和其他内部采样
不继承扩展预算，继续使用原有短重试。这避免 Provider 容量故障时由后台工作放大请求。

`provider_retry` lifecycle 新增：

- `mode`: `standard` 或 `bounded_foreground`；
- `phase=waiting`；
- `recoveryBudgetMs`、`recoveryElapsedMs`、`recoveryRemainingMs`；
- 终态 `exhaustedBy=attempt_limit|recovery_budget`。

这些字段只属于 runtime surface metadata，不进入 Provider payload、assistant 正文或
durable transcript。TUI 与 Web 在原状态栏内显示尝试数和剩余预算；Headless JSONL 与
ACP 使用结构化字段。

## 共享 Provider Circuit

多个 Web/ACP Session 会共享同一进程内的 Provider failure-domain circuit。identity
覆盖 channel、wire API、规范化 endpoint、model、service tier、API version、credential
与 routing headers；敏感值只参与进程随机 secret 驱动的 HMAC-SHA-256，不投影或落盘。

状态机：

```text
Closed
  -> 60 秒窗口至少 4 个样本且错误率 >= 80%
  -> Open
  -> open duration 到达后仅一个 lease owner
  -> HalfOpen probe
  -> success/neutral Provider response -> Closed
  -> transient failure -> Open
```

默认 Open `10000ms`；`providerCircuitBreakerOpenMs=0` 禁用，其他值必须为
`1000-300000ms`。有效 `Retry-After` 可延长当次 Open，但不能延长 foreground recovery
deadline。registry 固定 128 个 failure domain，每个滑窗固定 256 个样本；仅驱逐 idle
Closed 项，不使用后台 sweep timer。若全部 128 项均为 Open/HalfOpen，新 domain
fail-open 为 no-op circuit，避免无关 Provider 被全局拒绝。

每次 admission 都返回 generation/lease 绑定的 opaque token。正常 abort、deadline 与
idle timeout 会显式 abandon；owner 消失时 lease 最迟在 5-10 分钟内允许唯一 takeover。
旧 owner 在 takeover 后完成的结果因 token 不匹配而忽略，不能关闭或重新打开新状态。

请求语义：

- root foreground 的非末候选遇到 Open 时直接进入下一 fallback；
- root foreground 的末候选在原 `providerForegroundRecoveryMs` deadline 内等待，每
  15 秒发送 circuit heartbeat；
- background、internal 与 standard 请求不等待 Open candidate，同候选不重试，但仍可
  进入下一 fallback；
- circuit delay 与普通 retry backoff 取最大值，不相加；
- 首个真实 Provider chunk 记录 success 并保持原 replay boundary，后续 stream 故障
  不会回写为零输出 circuit failure。

`provider_circuit` 统一投影 `opened|waiting|probe|closed|reopened|rejected`，字段只含
sanitized reason/status、bounded retry-after、open duration、样本计数和可选 foreground
剩余预算。Headless JSONL、TUI、Web SSE/StatusBar、ACP metadata 与 subagent SSE 使用
同一协议，completion/reload 后清除瞬态状态。

## 流活性保护

HTTP 请求超时不等于流活性超时。部分 SDK 在响应头到达后不再用请求 timeout
约束响应体，因此连接静默断开时，消费端可能永久阻塞在下一条 SSE 事件。

Blade 在 pi-ai adapter 边界为每次模型尝试设置逐事件 watchdog：

- 默认 `300000ms`，可通过模型的 `overrides.streamIdleTimeout` 调整；
- 首条 provider 事件和任意两条事件之间都不能超过该时限；
- timeout 会主动中止当前 provider 请求，并产生可分类的 timeout 错误；
- provider 未发送 `done` 就关闭流时，按不完整传输处理，而不是误报成功；
- 最小配置值为 `1000ms`，防止误配置造成即时重试风暴。

watchdog 观察 pi-ai 的语义事件，而不是原始 socket 字节。空 keepalive 或无内容的
传输帧不会无限延长一个没有模型进展的请求。

主动 idle timeout 不会在同一 turn 自动重试。部分 Provider SDK 在响应头到达后
不能保证 abort 立即释放响应体；立即重试可能让多个失联请求重叠。Blade 将其投影为
可手动重试的标准 timeout task failure。相反，Provider 已明确关闭且没有交付任何
输出的 EOF 可以安全进入传输重试。

## 流式重放边界

只有尚未向 Agent loop 交付任何 `StreamChunk` 的尝试可以重试。以下任一事件出现后，本次请求就越过重放边界：

- 文本或 reasoning 增量；
- 完整工具调用；
- usage 或 finish 事件。

越过边界后发生的错误会直接上抛，不会从头请求当前模型，也不会切换 fallback 模型。这个限制同时保护终端输出和流式工具执行器：只读工具可能在流结束前预启动，重放同一 tool call 仍可能产生重复网络访问、重复 transcript 事件或状态竞争。

主模型在零输出状态下耗尽重试后，才允许进入配置的 fallback 模型。fallback 一旦产出 chunk，同样禁止继续切换其他模型。

## 设计依据与验证

该边界综合了 Codex 的集中式 stream retry、Claude Code 的前台有界恢复、Neovate Code 的可取消指数退避，以及 Grok Build 对确定性和瞬时错误的显式分类。Blade 额外把自身的流式工具预启动纳入重放判定，因此以首个对外 chunk 作为提交边界。

单元测试覆盖错误分类、provider 重试所有权、部分文本、工具调用和 abort。生产资格门禁还会为每个 DeepSeek 模型启动本地故障注入代理：首个真实 CLI 模型请求返回一次 HTTP `503`，后续请求转发到真实 API；轨迹必须完成代码修改、Bash 验证、diff 范围检查和宿主侧测试。
