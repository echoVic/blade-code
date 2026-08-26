---
name: knowledge-capacity-lifecycle-and-egress
description: >
  覆盖 Session、Task、Tool、Provider、Browser 的有界准入，跨 Session 公平性，SSE/ACP/Headless 输出背压，以及取消、关闭和进程树回收。
  使用时机：排查 429/resource_exhausted、队列饥饿、内存增长、输出乱序、Session 驱逐、Browser 容量、关闭挂起或孤儿进程。
  不包含：Provider 重试/熔断算法见 model-and-provider-runtime/provider-resilience-admission-and-observability，Shell 业务工具见 tool-and-automation-platform/shell-process-and-worktree。
  关键词：SessionRuntimeResidency, TaskRunScheduler, ConcurrencyScheduler, ProviderRequestAdmissionScheduler, BrowserProcessPool, BoundedSerialEgress, GracefulShutdown。
---

## Module Structure

该横切域用不同粒度的 reservation、permit、lease 和串行 egress 控制有限资源；每层都拥有独立队列、失败类型和释放责任，不能用一个全局 semaphore 替代。

### Directory Layout
- `packages/cli/src/agent/runtime/SessionRuntimeResidency.ts` — Web/ACP Runtime 驻留、pin、LRU 和 reservation
- `packages/cli/src/agent/runtime/TaskRunScheduler.ts` — 顶层 Task active/pending count 与 retained bytes
- `packages/cli/src/tools/execution/ConcurrencyScheduler.ts` — 进程和 Session 两级工具公平准入
- `packages/cli/src/tools/execution/ToolConcurrencyGate.ts` — 单 executor 的 shared/exclusive FIFO 屏障
- `packages/cli/src/services/pi/providerRequestAdmission.ts` — Provider domain/owner/class 加权准入
- `packages/cli/src/browser/BrowserOperationGate.ts` — 单 Session Browser 操作串行化
- `packages/cli/src/browser/BrowserProcessPool.ts` — 共享 Chromium 与隔离 Context lease
- `packages/cli/src/utils/BoundedSerialEgress.ts` — 通用有界单写者输出
- `packages/cli/src/server/OrderedSseEgress.ts` — replay/live 交接和 committed seq 顺序
- `packages/cli/src/services/GracefulShutdown.ts` — 信号、清理栈、Hook 和日志关闭
- `packages/cli/src/utils/process/` — owned process tree、admission gate 和 PID identity

### Decision Entry
- `SessionRuntimeResidency.reserve()` — 初始化前预留 Runtime 容量
- `TaskRunScheduler.admit()` — 顶层任务立即运行或进入 FIFO 队列
- `ConcurrencyScheduler.schedule()` — 按 Session round-robin 获取工具 permit
- `ProviderRequestAdmissionScheduler.admit()` — 按 failure domain、root owner 和 request class 准入
- `BrowserOperationGate.run()` / `BrowserProcessPool.acquire()` — 页面操作与 Chromium Context 两级容量
- `BoundedSerialEgress.offer()` — 在保留输出前同步判定 item/byte 上限
- `GracefulShutdownManager.shutdown()` — 取消活动命令并有界执行清理

## Branching Table

| 资源 | 有容量时 | 等待或可回收时 | 满载、失败或关闭时 |
|------|----------|----------------|--------------------|
| Session Runtime | reservation 计数后初始化并 commit lease | Web 可驱逐 idle、unpinned、`canEvict` 的 LRU resident | ACP 不驱逐；无候选返回可重试 `resident_runtimes` |
| 顶层 Task | active slot 空闲则立即运行且不计 pending bytes | paused 或 active 满时按 FIFO 计 pending count/bytes | 任一 pending 上限命中即在执行前拒绝 |
| 工具进程级准入 | 同时满足 global/session total 与 kind 限额后执行 | 每个 Session 只取队首，跨 Session round-robin | queue full 或 180 秒等待超时返回 `tool_busy` |
| 工具批内 gate | 连续 shared 调用并发 | exclusive 调用作为 FIFO 屏障 | pending 超 64 或 close 时取消未启动调用 |
| Provider stream | 未配置并发旋钮时直接请求；配置后取得 physical-attempt permit | foreground 优先、owner round-robin，background/internal 可 aging | count/bytes/full/timeout 返回脱敏可重试错误 |
| Browser | 进程池复用一个 Chromium，每 Session 独立 Context，操作严格 FIFO | 最后一个 Context release 时关闭 Chromium | Context 或操作队列满分别返回 `browser_capacity` / `browser_busy` |
| Surface egress | 单 writer 按接纳顺序输出 | `flush()` 只等待调用时已接纳的 high-water mark | overflow、oversized、write failure/timeout 关闭整条通道 |
| 进程关闭 | cleanup handlers 按注册逆序等待 | 单项失败继续执行其余 cleanup | 4 秒 cleanup budget 后报错，5 秒 hard timeout 强制退出 |

## Affected Scope
- `packages/cli/src/server/routes/session.ts` — Web Runtime 驻留、Task 429 映射和 Session SSE
- `packages/cli/src/acp/BladeAgent.ts` 与 `packages/cli/src/acp/Session.ts` — ACP 不驱逐驻留和有界 update egress
- `packages/cli/src/commands/headless.ts` 与 `packages/cli/src/commands/HeadlessOutputEgress.ts` — Headless 信号传播和 stdout/stderr 背压
- `packages/cli/src/tools/execution/ToolExecutor.ts` — 工具批内 gate、进程 permit 和 owner dispose
- `packages/cli/src/services/PiAIChatService.ts` — 每次 physical Provider attempt 的准入与释放
- `packages/cli/src/browser/SessionBrowserRuntime.ts` — Session 页面操作、Context lease 和 dispose
- `packages/cli/src/context/storage/` — 前台命令 lease、孤儿恢复和 durable process sidecar
- `packages/cli/src/hooks/SecureProcessExecutor.ts` 与 `packages/cli/src/lsp/LspClient.ts` — 共用 owned process tree
- `packages/cli/web/src/store/session/` — 容量事件、队列位置和流状态投影

## Gotchas
- Session Runtime 的未完成 reservation 也占硬上限，避免并发初始化在 commit 前穿透容量；所有创建失败路径都必须调用 `cancel()` (`packages/cli/src/agent/runtime/SessionRuntimeResidency.ts`)
- Web 只能驱逐 idle、未 pin、`canEvict()` 为真的 Runtime；ACP resident 永不隐式驱逐，客户端必须显式 `session/close` (`packages/cli/src/agent/runtime/SessionRuntimeResidency.ts`, `docs/configuration/config-system.md`)
- 被驱逐 Runtime 的 `dispose()` 失败时会恢复为 poisoned resident；它仍占容量但不可 acquire 或再次驱逐，防止把未确认清理的资源当作空位 (`packages/cli/src/agent/runtime/SessionRuntimeResidency.ts`)
- Task 和 Provider 的 byte budget 只约束等待队列；单个超过 pending budget 的请求在 active slot 空闲时仍可立即运行，但一旦需要排队就会被拒绝 (`packages/cli/src/agent/runtime/TaskRunScheduler.ts`, `packages/cli/src/services/pi/providerRequestAdmission.ts`)
- `TaskRunScheduler.configure()` 冻结进程级限制，单个 Session 的 admission options 不能把它降成项目私有值；project 配置不得覆盖进程容量 (`packages/cli/src/agent/runtime/TaskRunScheduler.ts`)
- 工具有两层独立顺序：`ToolConcurrencyGate` 保证同批 shared/exclusive 屏障，`ConcurrencyScheduler` 再限制进程/Session total 与 kind；删除任一层都会改变读写顺序或跨 Session 公平性 (`packages/cli/src/tools/execution/ToolConcurrencyGate.ts`, `packages/cli/src/tools/execution/ConcurrencyScheduler.ts`)
- 工具 validation、worktree 隔离、Hook、权限和人工审批发生在 scarce permit 前；把审批移到 scheduler 内会让等待用户的调用长期占用执行容量 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `docs/reference/tool-concurrency.md`)
- Provider admission 默认关闭，只有配置 domain/global/owner 任一并发旋钮才启用；不能把 scheduler 常量误当成未配置时的隐藏吞吐限制 (`packages/cli/src/services/PiAIChatService.ts`, `docs/reference/model-transport-recovery.md`)
- Provider permit 只覆盖一次真实 stream iterator，必须在 error、EOF 或 consumer return 后释放，再进行 retry backoff、circuit wait 或 fallback；跨重试持有 permit 会造成自锁和饥饿 (`packages/cli/src/services/PiAIChatService.ts`)
- Provider 队列先按 foreground/background/internal 排序，再按 root owner round-robin；aging 会提升长期等待的 internal 请求，但不会改变其 pending class 计费 (`packages/cli/src/services/pi/providerRequestAdmission.ts`)
- Browser 操作 gate 是单 Session 严格 FIFO，不区分只读与写；关闭会中止 active operation 并拒绝全部 queued operation，调用方必须等待 `close()` 返回再释放 Context (`packages/cli/src/browser/BrowserOperationGate.ts`)
- BrowserProcessPool 的 launch failure 不缓存，意外断连会递增 generation 并使所有现有 lease 失效；旧 lease 的迟到 release 不得关闭新一代 Browser (`packages/cli/src/browser/BrowserProcessPool.ts`)
- `BoundedSerialEgress` 任一 admission overflow 会关闭整条 transport，并拒绝已经接纳但尚未完成的项；它不是“只丢弃最新消息”的 ring buffer (`packages/cli/src/utils/BoundedSerialEgress.ts`)
- SSE replay 期间会丢弃 buffered ephemeral 事件、按 seq 排序 committed 事件并去重；live committed seq 回退则立即关闭订阅 (`packages/cli/src/server/OrderedSseEgress.ts`)
- POSIX 进程树必须以 detached group leader 启动；leader 已退出不代表 PGID 已结束，回收孤儿时还要在 SIGKILL 前重新校验 PID identity，防止杀死复用 PID (`packages/cli/src/utils/process/OwnedProcessTree.ts`, `packages/cli/src/utils/process/ProcessIdentity.ts`, `git:fb8d6121`)
- Graceful shutdown 先 abort 活动 command，再逆序执行 cleanup，随后执行 SessionEnd Hook 和 logger shutdown；cleanup handler 不应自行 `process.exit()` 截断后续回收 (`packages/cli/src/services/GracefulShutdown.ts`)

## Architecture
- Runtime、Task、Tool、Provider 和 Browser 各自拥有与故障域匹配的准入器：Session 用 reservation/lease，Task/Provider 用 ticket/permit，工具另加批内 barrier，Browser 另加 Context pool (`packages/cli/src/agent/runtime/SessionRuntimeResidency.ts`, `packages/cli/src/services/pi/providerRequestAdmission.ts`)
- 进程级公平调度以 Session 或 root owner 为轮转单位，局部受阻的队首不会阻塞其他 eligible owner；取消和释放都会立即重新 drain (`packages/cli/src/tools/execution/ConcurrencyScheduler.ts`, `packages/cli/src/services/pi/providerRequestAdmission.ts`)
- Surface egress 将内存上限、单 writer、写超时和关闭传播集中在通用队列，SSE、ACP 与 Headless 只负责各自的编码和 replay 语义 (`packages/cli/src/utils/BoundedSerialEgress.ts`, `packages/cli/src/server/OrderedSseEgress.ts`)

## Decisions
- 输出背压采用断开慢消费者而不是丢事件，因为 committed 事件顺序和完整性高于维持单个慢连接；其他订阅者不受影响 (`packages/cli/src/server/OrderedSseEgress.ts`, `git:1af43232`)
- 工具并发同时保留 process total、Session total 和 kind 上限，避免一个 Session 或大量 readonly 调用挤占全部 execute/write 容量 (`packages/cli/src/tools/execution/ConcurrencyScheduler.ts`, `git:527cb02b`)
- Provider 准入使用 failure-domain 与 root-owner 双重隔离，并给 foreground 保留容量；这是为了让后台子任务和内部采样不能放大上游故障 (`packages/cli/src/services/pi/providerRequestAdmission.ts`, `git:852c8cba`, `git:471f90f0`)

## Branching Behavior
- Session Runtime 容量满时，Web reservation 可先回收最旧 eligible resident；ACP reservation 直接返回 typed capacity error，不改变任何已有 Session (`packages/cli/src/agent/runtime/SessionRuntimeResidency.ts`)
- Task scheduler paused 时即使有 active slot 也排队；resume 或提高并发限制会按 FIFO drain，降低 byte limit 不会驱逐已经接受的等待项 (`packages/cli/src/agent/runtime/TaskRunScheduler.ts`)
- Tool shared 调用只在队首连续 shared 区间并发；遇到 exclusive 后，后续 shared 不能越过该屏障 (`packages/cli/src/tools/execution/ToolConcurrencyGate.ts`)
- Provider foreground 排在较新的 background/internal 前，但每 30 秒 aging 一级，长期 internal 最终可提升到 foreground rank (`packages/cli/src/services/pi/providerRequestAdmission.ts`)
- SSE fresh 连接按 callback 到达顺序释放初始化缓冲，带 replay 的连接改按 committed seq 排序且只发送高于 replay 水位的事件 (`packages/cli/src/server/OrderedSseEgress.ts`)
- Browser Context 数量达到上限时拒绝新 Session，不会抢占已有 Context；同一 Context 内的页面操作则进入有界串行队列 (`packages/cli/src/browser/BrowserProcessPool.ts`, `packages/cli/src/browser/BrowserOperationGate.ts`)
- 进程自然退出会释放 `OwnedProcessTree` 所有权；durable admission gate 则可设置 `releaseOnExit: false`，直到独立确认整个进程组已清理才释放 (`packages/cli/src/utils/process/CommandAdmissionGate.ts`, `packages/cli/src/utils/process/OwnedProcessTree.ts`)
