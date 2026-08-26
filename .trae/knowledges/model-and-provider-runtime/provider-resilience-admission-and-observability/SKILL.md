---
name: knowledge-model-and-provider-runtime-provider-resilience-admission-and-observability
description: >
  覆盖跨 Agent、Session、Subagent、CLI/Web/ACP 表面的 Provider 重试、前台恢复、
  failure-domain 熔断、公平准入、stream stall、Prompt Cache 与费用观测。
  Navigate when: 调试 429/5xx/timeout、重复请求、Open/HalfOpen、容量排队、后台饥饿、缓存命中
  下降、状态栏或事件投影。Excludes: 模型目录与凭据配置（见
  ../model-catalog-configuration-and-credentials/），消息和 payload 协议映射（见
  ../provider-transport-and-context-adaptation/）。Keywords: ProviderRequestAdmissionScheduler,
  ProviderCircuitRegistry, provider_retry, provider_circuit, provider_admission,
  provider_stall, bounded_foreground, PromptCacheBreakMonitor, Retry-After.
---

## Module Structure

该节点不是单一模块，而是包围每条物理 Provider stream 的横切控制面。它根据请求类别、
失败类型、候选位置、输出边界和显式容量配置选择不同恢复路径，并向所有运行表面投影
同一组临时事件。

### Directory Layout
- `packages/cli/src/services/PiAIChatService.ts` — 恢复、熔断、准入、deadline 与 fallback 总编排
- `packages/cli/src/services/pi/providerRetry.ts` — 错误分类、Retry-After 和退避
- `packages/cli/src/services/pi/providerCircuitBreaker.ts` — 进程共享 Closed/Open/HalfOpen 状态机
- `packages/cli/src/services/pi/providerFailureDomain.ts` — 敏感路由维度的规范化 HMAC 身份
- `packages/cli/src/services/pi/providerRequestAdmission.ts` — 进程共享加权公平队列与 permit
- `packages/cli/src/services/pi/providerRequestFootprint.ts` — 等待请求 retained-footprint 估算
- `packages/cli/src/services/pi/providerStall.ts` — stall 生命周期契约
- `packages/cli/src/services/pi/promptCacheBreakMonitor.ts` — Session 级缓存断裂归因
- `packages/cli/src/services/ProviderHealthService.ts` — 受限、脱敏的真实 Provider 探测
- `packages/cli/src/api/promptCacheMetrics.ts` — 缓存指标归一化和展示格式

### Decision Entry
- `PiAIChatService.streamChat()` in `packages/cli/src/services/PiAIChatService.ts` — 依据 recovery mode、request class、candidate index、circuit/admission 状态和首个真实 chunk 选择分支
- `classifyProviderRetry()` in `packages/cli/src/services/pi/providerRetry.ts` — 将错误链和响应头归类为可重试或终止
- `ProviderRequestAdmissionScheduler.admit()` in `packages/cli/src/services/pi/providerRequestAdmission.ts` — 决定立即运行、排队或按 count/bytes 拒绝

## Branching Table

| 决策维度 | 分支 A | 分支 B |
|---|---|---|
| 准入是否启用 | 三个 concurrency 配置均未设置时不创建 scheduler，物理流直接访问 Provider | 任一 concurrency 配置显式设置或注入 scheduler 时，所有 primary/retry/fallback/probe 先取 permit |
| 请求类别 | root 用户阻塞请求为 `foreground`，可携带 bounded recovery | Subagent/Hook 为 `background`，健康探测等为 `internal`，不继承扩展恢复 |
| Open circuit 与候选位置 | 非末 fallback 候选或 standard 请求立即拒绝该候选并继续 fallback/失败 | bounded foreground 的末候选在原 recovery deadline 内等待唯一 HalfOpen probe |
| 错误类型 | 408/409/429、5xx、transport、零输出 EOF 和 physical deadline 可进入有界重试 | quota/context、caller abort、recovery budget、idle timeout 不重试同一候选 |
| 流式提交边界 | 首个真实 chunk 前的可重试失败可重放并切换 fallback | text/reasoning/tool/usage/finish 任一已交付后 fail closed，不再重试或 fallback |
| 容量状态 | 队列为空且 capacity 可用时立即运行，超大请求不计 pending bytes | 必须等待时同时受 count、retained bytes 和 wait deadline 限制，`0` 表示 fail-fast |
| 时间预算 | admission 后启动每次 physical attempt 的 total deadline，语义事件只刷新 idle watchdog | foreground recovery 启动后覆盖 backoff、排队、建连和 stream，并在更早/相等时保持权威错误原因 |
| Prompt Cache | 关闭缓存时清除 Session 基线；普通启用使用 short retention | 带稳定 Session ID 的非官方 OpenAI-compatible completion endpoint 使用 long retention |

## Affected Scope
- `packages/cli/src/agent/loop/` — 决定 foreground/background 类别、恢复预算与四类 Provider 事件顺序
- `packages/cli/src/agent/subagents/` — 持久化并向嵌套子代理传播 root admission owner
- `packages/cli/src/agent/teams/` — Team 成员共享 root Session 的 Provider 容量所有权
- `packages/cli/src/context/CompactionService.ts` — 压缩采样复用 ChatService，并显式携带准入身份
- `packages/cli/src/hooks/HookExecutor.ts` — Prompt Hook 以 background 类别参与同一准入
- `packages/cli/src/server/routes/session.ts` — 将 root/subagent 生命周期投影为 SSE
- `packages/cli/src/commands/headless.ts` — 输出并校验 Headless Provider JSONL 生命周期
- `packages/cli/src/acp/Session.ts` — 将临时状态映射为 ACP metadata 并在终态清除
- `packages/cli/src/ui/` 与 `packages/cli/web/src/` — 按优先级显示排队、熔断、重试、stall 和缓存指标

## Gotchas
- `DEFAULT_PROVIDER_REQUEST_CONCURRENCY=4` 是显式配置归一化的默认值，不代表产品默认启用四并发；没有设置任何 concurrency 旋钮时 `PiAIChatService` 完全绕过 process-wide scheduler (`packages/cli/src/config/providerRequestAdmission.ts`, `packages/cli/src/services/PiAIChatService.ts`)
- context overflow 与额度/账单错误即使被网关包装为 HTTP 500 也必须终止，不得进入 transport retry 或 fallback；`X-Should-Retry: false` 同样优先于状态码 (`packages/cli/src/services/pi/providerRetry.ts`)
- idle timeout 会主动中止失联 iterator 且不自动重试同一候选，因为 SDK 未必及时释放响应体；它在零输出时仍可切换下一 fallback，和可重试 EOF 的行为不同 (`packages/cli/src/services/PiAIChatService.ts`, `packages/cli/src/services/pi/streamAdapter.ts`)
- 首个真实 Provider chunk 同时是 replay commit 和 circuit success；之后即使流失败，也不能把该 attempt 记成零输出故障去打开 circuit，否则会重复已经展示的文本或预启动的工具调用 (`packages/cli/src/services/PiAIChatService.ts`)
- circuit `Retry-After` 与普通指数退避取最大值而不是相加；服务器延长 Open 时间也不能延长 foreground recovery 的绝对 deadline (`packages/cli/src/services/PiAIChatService.ts`, `packages/cli/src/services/pi/providerCircuitBreaker.ts`)
- pending byte 限制只约束被队列保留的请求；capacity 空闲且队列为空时，即使单个请求大于 pending budget 也可直接运行，不能把它误当成请求体大小限制 (`packages/cli/src/services/pi/providerRequestAdmission.ts`)
- 排队请求若因 `queue_full` 终止，会持久化 failed abort 并确认该 turn 已 claim 的输入，避免 Web reload、SSE reconnect 或 ACP load 绕过准入重放；wait timeout、cancel 和 crash 仍保留恢复语义 (`docs/testing/bounded-weighted-provider-admission-evidence.md`)
- Prompt Cache 断裂监控在 compaction 改变 `contextEpoch` 时只重置比较基线，不报告断裂；否则正常上下文缩短会被误判为缓存失效 (`packages/cli/src/services/pi/promptCacheBreakMonitor.ts`)
- Provider 未报告 cache read/write bucket 时命中率保持 unavailable，而不是 `0%`；展示层必须区分“不支持/未知”和“明确零命中” (`packages/cli/src/api/promptCacheMetrics.ts`)

## Architecture
- circuit 与 admission 使用同一组 Provider 路由维度，但分别加入自己的策略字段后由进程随机 secret 做 HMAC；endpoint、credential、routing headers 和 owner/session 身份不进入 key 之外的投影或持久化 (`packages/cli/src/services/pi/providerFailureDomain.ts`, `packages/cli/src/services/pi/providerCircuitBreaker.ts`, `packages/cli/src/services/pi/providerRequestAdmission.ts`)
- circuit 在 60 秒窗口至少 4 个样本且错误率达到 80% 时 Open；到期后只有一个 generation/lease 绑定的 probe，旧 owner 在 lease takeover 后返回的结果会因 token 不匹配被忽略 (`packages/cli/src/services/pi/providerCircuitBreaker.ts`)
- admission 同时维护 global、failure-domain、root-owner 与 class 计数；每个 owner 只贡献当前最高有效优先级 ticket，同级 owner 稳定轮转，等待每满 30 秒提升调度 rank 但不改变计费 class (`packages/cli/src/services/pi/providerRequestAdmission.ts`)
- 一个逻辑 `streamChat()` 只估算一次 messages、Context、tools 与 request options 的 retained footprint，primary、retry、fallback 和 probe 复用同一数值；scheduler 不保留原请求对象图 (`packages/cli/src/services/PiAIChatService.ts`, `packages/cli/src/services/pi/providerRequestFootprint.ts`)
- permit 覆盖完整 Provider iterator 生命周期，但不跨 retry backoff、circuit wait、工具执行或 fallback 选择；排队本身不增加 physical attempt，拿到 permit 后还必须二次检查 circuit (`packages/cli/src/services/PiAIChatService.ts`)
- Prompt Cache monitor 以 Session 为键保留最多 32 个 LRU 基线，只保存 system、工具身份/契约和请求策略的 SHA-256 指纹；模型回复、工具名称和 schema 正文不进入观测状态 (`packages/cli/src/services/pi/promptCacheBreakMonitor.ts`)

## Decisions
- 前台长任务恢复从第一个“可安全重放的瞬时错误”开始计时，而不吞掉初次正常请求耗时；默认最多追加 12 次且总预算 10 分钟，显式 `maxRetries` 包括 `0` 始终优先 (`packages/cli/src/config/foregroundProviderRecovery.ts`, `packages/cli/src/services/PiAIChatService.ts`, `git:f1e80c2a`)
- circuit registry 固定最多 128 个 failure domain、每域 256 个窗口样本，只同步驱逐 idle Closed 项；容量全被 Open/HalfOpen 项占用时新 domain 获得 no-op handle 而非全局拒绝 (`packages/cli/src/services/pi/providerCircuitBreaker.ts`)
- admission 的 pending count 与 retained bytes 是独立硬边界，所有拒绝在分配 timer、abort listener 和持久 owner/domain 状态前完成，以限制 Provider 故障期间的进程内存增长 (`packages/cli/src/services/pi/providerRequestAdmission.ts`, `git:471f90f0`)
- Prompt Cache 断裂只有在前次 cache-read 至少 1000 tokens 且下降同时超过自适应绝对阈值与 5% 相对阈值时才报告，避免把普通抖动当作策略变更 (`packages/cli/src/services/pi/promptCacheBreakMonitor.ts`)

## Patterns
- root Session ID 是整棵 Task/Team/Subagent 树的 admission owner；恢复和嵌套执行必须继续传播 `providerAdmissionOwnerId`，否则子任务可通过新 owner 绕过 owner 上限 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/agent/subagents/BackgroundAgentManager.ts`, `packages/cli/src/agent/teams/TeamRuntime.ts`)
- 排队 ticket 的取消会同步移除自身、撤销精确 count/byte charge 并保留 caller reason；permit 的 `release()` 幂等，所有终止路径都可安全重复清理 (`packages/cli/src/services/pi/providerRequestAdmission.ts`)
- circuit 的 timeout 不作为共享故障样本；有 HTTP metadata 的确定性失败记录 neutral，idle timeout 则 abandon token，防止本地 deadline 或失联响应体把所有 Session 的 channel 错误熔断 (`packages/cli/src/services/PiAIChatService.ts`)
- cache break 归因优先级固定为 model → system prompt → tools → request policy → TTL → server-side；同一次观测可能有多个变化，但只输出首个主原因和独立布尔明细 (`packages/cli/src/services/pi/promptCacheBreakMonitor.ts`)

## Conventions
- `provider_admission`、`provider_circuit`、`provider_retry`、`provider_stall` 都是临时控制事件；新增字段需同步 Agent loop、Headless schema、SSE、ACP、TUI 与 Web 清理逻辑，不能写入 assistant content (`packages/cli/src/agent/loop/types.ts`, `packages/cli/src/commands/headlessEvents.ts`, `packages/cli/src/server/routes/session.ts`)
- 所有时长和容量配置先做 safe-integer 范围校验；`0` 只在明确约定的 recovery、circuit 和 admission wait 中表示禁用或 fail-fast，concurrency 与 pending bytes 不接受 `0` (`packages/cli/src/config/foregroundProviderRecovery.ts`, `packages/cli/src/config/providerCircuitBreaker.ts`, `packages/cli/src/config/providerRequestAdmission.ts`)

## Dependencies
- Provider 响应头观测依赖 pi-ai 的 `onResponse`，并对支持的 HTTP API 安装 fetch 包装；重试策略依赖两者提供的 status、`Retry-After` 与 `X-Should-Retry` (`packages/cli/src/services/pi/requestOptions.ts`)

## Branching Behavior
- bounded foreground 默认共享 primary 与所有 fallback 的绝对 deadline 和 12 次附加尝试上限；显式 `maxRetries` 则恢复为每个 candidate 各自计数 (`packages/cli/src/services/PiAIChatService.ts`)
- standard、background 与 internal 请求遇到 Open candidate 时不等待也不重试该 candidate，但如果还有 fallback 仍可继续；只有 bounded foreground 的末候选承担 circuit wait (`packages/cli/src/services/PiAIChatService.ts`)
- scheduler 直接使用时默认保留 foreground 的 class 配额；产品通过任一 concurrency 配置启用 scheduler 时显式设置 `classLimitsEnabled: false`，因此只执行用户配置的 global/domain/owner active 限制，pending count/bytes 仍保持有界 (`packages/cli/src/services/pi/providerRequestAdmission.ts`, `packages/cli/src/services/PiAIChatService.ts`)
- foreground、background、internal 的优先级依次为 0、1、2；aging 只提升排队 rank，internal 即使老化到 foreground rank 仍计入 internal count/byte lane (`packages/cli/src/services/pi/providerRequestAdmission.ts`)
- 已知 Open circuit 在排队前拦截；若排队期间其他 Session 打开 circuit，拿到 permit 后的原子 `check()` 会零流量释放 permit，再按 candidate/recovery 分支处理 (`packages/cli/src/services/PiAIChatService.ts`)
- admission wait 在 recovery 尚未开始时使用完整 admission deadline；恢复开始后取 admission deadline 与 recovery remaining 的较小值，后者耗尽时保持 `recovery_budget` 终态而不是改写为 `wait_timeout` (`packages/cli/src/services/PiAIChatService.ts`)
- physical total timeout 只在取得 permit 后开始且任何语义事件都不能刷新；idle watchdog 在每个 pi-ai 事件后重置，二者与 recovery deadline 竞速时由更早边界中止 (`packages/cli/src/services/PiAIChatService.ts`, `packages/cli/src/services/pi/streamAdapter.ts`)
- 健康探测强制 temperature 0、最多 8 tokens、`maxRetries: 0`、无 fallback，并以 `internal` 类别参与准入；结果只返回 canonical code/message，绝不回传模型正文或原始异常 (`packages/cli/src/services/ProviderHealthService.ts`)

## Observability and Privacy
- Prompt Cache 工具 diff 通过名称 hash 对齐身份、通过完整稳定序列化 hash 判断契约变化，既能区分 added/removed/changed，又不在事件或内存快照中保留工具名 (`packages/cli/src/services/pi/promptCacheBreakMonitor.ts`, `git:9bc23832`)
- cache hit rate 会先钳制 Provider 的不一致计数，再从互斥的 read/write/uncached buckets 计算；不能直接信任 Provider 上报值相加后仍小于总输入 (`packages/cli/src/api/promptCacheMetrics.ts`)
- `estimateCostUsd()` 在提供 provider ID 时可精确处理重复 model ID；省略 provider 时取 catalog 中第一个同名模型，跨渠道费用展示应优先传 provider ID (`packages/cli/src/services/pricing.ts`)
