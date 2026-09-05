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

## 统一 Provider 恢复状态

`SessionRuntime` 现在拥有当前 root turn 的唯一恢复投影。准入等待、重试、熔断器、
输出停滞和模型 fallback 不再由各个客户端各自推断，而是归并为同一个
`ProviderRecoveryProjectionV1`：

```ts
interface ProviderRecoveryProjectionV1 {
  version: 1;
  generation: string;
  revision: number;
  snapshot: ProviderRecoverySnapshotV1 | null;
}
```

`snapshot.activity` 只可能是 `admission_wait`、`retry_wait`、`retry_attempt`、
`circuit_open`、`circuit_probe`、`stream_stall` 或 `fallback`。当多个底层状态同时存在时，
展示优先级固定为：stall、circuit、retry、admission、fallback。fallback 信息可以作为
上下文保留，例如 fallback candidate 正在 retry 时，主 activity 仍是 `retry_wait`。

每个顶层 run 先发布一个 revision `0`、`snapshot: null` 的新 generation，之后每次状态
变化递增 revision。Runtime 会拒绝旧 generation；Web 也只接收已由 revision `0` 锚定的
新 live generation 和同 generation 的更大 revision。SSE `connected` 携带权威快照，可以
替换本地旧状态；空闲且没有 resident Runtime 的 Session 明确返回 `null`。因此刷新或
EventSource 重连可以恢复仍在进行的倒计时，同时迟到事件不能在终态后复活 banner。

各入口使用同一投影：

- TUI 的 `LoadingIndicator` 显示恢复原因、绝对 deadline 倒计时、尝试/预算/队列信息和
  既有 `Esc` 停止提示，`ChatStatusBar` 保留紧凑摘要；
- Web GUI 在 composer 上方显示带 `role=status`、`aria-live=polite` 的 banner，Stop
  复用既有 abort API，StatusBar 显示紧凑摘要；
- ACP 使用 `_meta['blade/providerRecovery']`；
- Headless JSONL 使用 `type=provider_recovery`，clear 由 `snapshot: null` 表示。

正常输出、工具开始、结构化输出、完成、失败、取消、consumer 提前关闭、Session
切换和 Runtime dispose 都会清除瞬态状态。倒计时只从 Runtime 给出的绝对
`nextActionAt` 在客户端本地计算，不会延长恢复预算，也不会产生每秒协议事件。

模型切换同时提供 typed `model_fallback`，只包含规范化后的 source/target
`{ provider, model }`、候选序号/总数和封闭的 trigger 分类。它不会覆盖统一恢复快照，
也不会授予中途切换或重放权限。两种协议都使用封闭 TypeBox schema；API key、base URL、
headers、请求/响应正文和原始错误不能进入投影、UI、transcript 或持久化 Session 数据。

## Provider 请求准入

默认不创建 process-wide admission scheduler；primary、retry、fallback 与 HalfOpen
probe physical stream 直接请求 Provider，由真实 `429`、`retry-after` 和共享熔断器
提供背压。仅当用户显式设置 `providerRequestConcurrency`、
`providerGlobalConcurrency` 或 `providerOwnerConcurrency` 时才启用准入。

`providerRequestConcurrency` 限制同一 endpoint/model/tier/credential failure
domain（`1-16`）；global 和 owner 分别限制全进程与同一 root Session 及其全部
descendant。未设置的层级不限制，foreground、background 与 internal 也没有隐藏的
class in-flight 配额。启用准入后，pending count 和 retained-footprint 仍保持有界，
队列按 request class 与 root owner 公平调度。

等待默认最多 180 秒，每 15 秒投影 heartbeat，caller abort 会原子移除 ticket。
`providerRequestAdmissionMs=0` 表示 fail-fast，其他值必须为 `1000-600000`。
`providerRequestPendingBytes` 默认 128 MiB，可配置为 64 KiB-128 MiB。active capacity
空闲时不使用 pending byte budget。

顺序固定为：

```text
circuit preflight
  -> Provider admission
  -> atomic circuit check/probe claim
  -> physical stream
  -> release permit
  -> retry/circuit wait or fallback
```

已知 Open circuit 不进入容量队列；排队后 circuit 若被其他 Session 打开，request
取得 permit 后会二次检查并零 Provider traffic 释放容量。permit 不跨 retry backoff、
circuit wait、tool execution 或 fallback selection。排队不增加 physical attempt；
foreground recovery 已启动时，admission wait 与原绝对 deadline 共用剩余预算。

`provider_admission` 只投影 `queued|admitted|rejected`、request class、
`stream|pending_count|pending_bytes` resource、capacity scope、队列/active 整数与
bounded wait；request footprint、aggregate pending bytes、failure-domain、root owner、
Session ID、endpoint、credential 和 HMAC 均不进入 surface 或 transcript。

retry/fallback 最终仍以 `queue_full` 结束时，该 turn 保留
`turn_aborted(cause=failed)`，同时只确认本 turn 已 claim 的 durable input。Web reload、
SSE reconnect 和 ACP load 不会绕过 admission 边界重放同一请求；Provider outage、
`wait_timeout`、caller cancel 和 process crash 继续保留原输入恢复语义。

## 共享 Provider Circuit

多个 Web/ACP Session 会共享同一进程内的 Provider failure-domain circuit。identity
覆盖 channel、wire API、规范化 endpoint、model、service tier、API version、credential
与 routing headers；敏感值只参与进程随机 secret 驱动的 HMAC-SHA-256，不投影或落盘。

状态机：

```text
Closed
  -> 首个 429 + 有效 Retry-After 立即 Open
  或
  -> 60 秒窗口至少 4 个样本且错误率 >= 80%
  -> Open
  -> open duration 到达后仅一个 lease owner
  -> HalfOpen probe
  -> success/neutral Provider response -> Closed
  -> transient failure -> Open
```

服务端明确返回 `429` 且携带有效正数 `Retry-After` 或 `Retry-After-Ms` 时，
Blade 不等待四样本阈值：首个失败样本立即让相同 failure domain 进入 Open。后续
Session 会在发出物理 Provider 请求前等待，边界到达后仍只有一个 HalfOpen probe owner。
Open 时长为配置值与服务端指令的较大值，并继续受 `300000ms` 上限约束。缺失、零、
负数或非有限指令不会触发这条快速路径；非 `429` 响应也继续使用原阈值。

该冷却只存在于当前进程内，不跨进程重启持久化，也不代表订阅、余额或购买状态。TUI
会显示 `Provider 请求受限，等待恢复探测`，Web GUI 显示 rate-limit 专用 banner；
Headless、ACP 和 Web SSE 继续复用既有 `provider_circuit` / `provider_recovery` 协议。
响应正文、endpoint、header 与 credential 不会进入这些表面。

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

## 请求总时限与流活性保护

HTTP SDK 的 request timeout 和流活性 timeout 都不能单独构成完整边界。部分 SDK
在响应头到达后不再用 request timeout 约束响应体；另一方面，只要 Provider 持续发送
reasoning 或 text 增量，idle watchdog 也会不断刷新，单次 physical attempt 仍可能
无限占用 admission permit。

Blade 在 pi-ai adapter 边界同时执行两个独立时限：

- `timeout` 是每个 physical attempt 的 hard total deadline，默认 `180000ms`；
- total deadline 只在 Provider admission 成功后开始，queue wait 不消耗该预算；
- text、reasoning、tool、usage、finish 或 stall recovery 都不能刷新 total deadline；
- `overrides.streamIdleTimeout` 是逐语义事件 idle watchdog，默认 `300000ms`；
- 首条 Provider 事件和任意两条事件之间都不能超过 idle 时限；
- 两者都会主动中止当前 Provider 请求，正常完成、错误和取消都会清理 timer；
- Provider 未发送 `done` 就关闭流时，按不完整传输处理，而不是误报成功；
- `streamIdleTimeout` 的最小配置值为 `1000ms`，防止误配置造成即时重试风暴。

retry 与 fallback 每次取得新的 admission permit 后都会建立新的 attempt deadline。
若 foreground recovery 的共享单调 budget 更早或与 attempt deadline 相等，共享 budget
保持 authoritative abort cause；只有 attempt deadline 严格更早时才由它终止本次请求。

watchdog 观察 pi-ai 的语义事件，而不是原始 socket 字节。空 keepalive 或无内容的
传输帧不会无限延长一个没有模型进展的请求。

total deadline 在零真实输出边界内按标准 timeout policy 进入有界 retry；已经交付
text、reasoning、tool、usage 或 finish 后则标记 replay boundary 并 fail closed。
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
