---
name: knowledge-session-state-and-context-active-turn-interactions-and-recovery
description: >
  覆盖 Session 活动轮次互斥、durable steering/follow-up、turn 崩溃恢复、持久用户交互、私有大 prompt、旁路问答和用户 Shell。
  适用于修改 ActiveTurnMailbox、SessionLease、SessionRuntime 恢复顺序、permission/question recovery、/btw 或 ! command。
  不含历史目录/fork/rewind（见 ../session-catalog-fork-rewind-and-export/）和上下文压缩策略（见 ../context-compaction-token-budget-and-memory/）。
  关键词：ActiveTurnMailbox, DurableSteeringInbox, SessionLease, turn_started, turn_aborted, interaction_recovered, UserPromptArtifactStore, side conversation。
---

## Module Structure

该节点管理“当前 Session 此刻能做什么”以及进程退出后如何继续。内存 mailbox 负责原子状态转换，sidecar 保存未确认输入，JSONL 保存 turn/tool/interaction receipt，SessionRuntime 在持有 lease 后协调恢复。

### Directory Layout
- `packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`：单活动 turn、claim/seal/ack 与输入容量
- `packages/cli/src/agent/runtime/DurableSteeringInbox.ts`：crash-safe pending input sidecar
- `packages/cli/src/agent/runtime/SessionLease.ts`：跨进程 Session owner 锁
- `packages/cli/src/agent/runtime/ActiveOperationGate.ts`：关闭时停止接纳、取消并排空活动操作
- `packages/cli/src/agent/runtime/UserPromptArtifactStore.ts`：大型用户请求的私有内容寻址存储
- `packages/cli/src/agent/runtime/SessionRuntime.ts`：初始化、turn 终态、恢复和辅助交互编排
- `packages/cli/src/context/interactions.ts`：interaction request/response/recovery projector
- `packages/cli/src/services/SessionInteractionService.ts`：durable 交互协议
- `packages/cli/src/services/SideConversationService.ts`：不改变主历史的一次性旁路问答
- `packages/cli/src/services/UserShellCommandService.ts`：Session-owned 用户命令执行与有界输出

### Key Entry Points
- `SessionRuntime.initialize()` in `packages/cli/src/agent/runtime/SessionRuntime.ts`：获取 lease 并修复 orphan 状态
- `ActiveTurnMailbox.prepareInputTurn()` / `enqueue()` in `packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`：原子接纳首轮输入或 steering
- `PersistentStore.recoverInterruptedTurn()` in `packages/cli/src/context/storage/PersistentStore.ts`：关闭 orphan tool call 与未终止 turn
- `SessionInteractionService.resolvePendingWithHandler()` in `packages/cli/src/services/SessionInteractionService.ts`：重放未回答交互
- `SessionRuntime.executeUserShellCommand()` in `packages/cli/src/agent/runtime/SessionRuntime.ts`：执行、持久化并安全注入用户命令结果

## Gotchas
- `isActive()` 在 turn sealed 后返回 false，但 `hasTurnOwner()` 仍为 true；切模型、reload inbox、fork/rewind 等互斥判断必须选择正确谓词，不能把“不能再接当前 turn steering”误当作“没有 owner” (`packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- `drainOrSeal()` 在同一个 mutex 临界区内“发现新消息或封口”，封口后到达的输入必须标记 `next_turn`；拆开检查与 seal 会丢失边界竞态 (`packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`)
- `claimed` 只代表当前 turn 已取走，并不代表 durable 完成；正常终态先原子提交 inbox acknowledgement 与 `turn_completed`，成功后才从 sidecar 删除 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)
- abort 默认不确认输入，使进程故障、取消和暂态失败可在冷启动重放；只有显式 `acknowledgeInput` 或 terminal queue-full 等确定性边界才能消费对应 ID (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)
- `prepareInputTurn()` 总是先把输入持久到 inbox 再建立 owner；若已有旧 pending input，新 prompt 排在其后且返回 `mode: pending`，不能越过恢复输入直接执行 (`packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`)
- user steering 上限为 20 条且受内容/schema/metadata 合并预算约束；background completion 独立使用 100 条与约 7 MiB 预算，但所有来源最终还共享 8 MiB inbox 文件硬上限 (`packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`, `packages/cli/src/agent/runtime/DurableSteeringInbox.ts`)
- 指定相同 message ID 的重复 enqueue 被视为幂等成功；调用方必须复用 durable identity，不能在 retry 时生成新 ID 导致重复 follow-up (`packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`)
- inbox 打开时会用 JSONL acknowledgement 和已应用的 abort receipt 过滤消息，并把剩余项标记 recovered；损坏或超 8 MiB 的 sidecar 直接 fail closed (`packages/cli/src/agent/runtime/DurableSteeringInbox.ts`)
- Session lease 只有在 PID 存活且进程启动身份仍匹配时才阻止新 owner；PID 被复用会回收旧锁，release 也会核对 `ownerId` 以免删除后来 owner 的锁 (`packages/cli/src/agent/runtime/SessionLease.ts`)
- Runtime 必须先取得 Session lease，再依次修复 foreground/background 进程、patch、subagent、mailbox、orphan tool/turn 和 Goal receipt；初始化中途失败会调用 dispose 释放部分资源 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `git:8cd32a8a`)
- 通用 interrupted-turn recovery 不处理仍有 pending durable interaction 的 tool call，该调用必须留给专用 interaction recovery，避免先写 uncertain result 再重放问题 (`packages/cli/src/context/storage/PersistentStore.ts`, `docs/reference/durable-pending-interactions.md`)
- interaction request 只有在所属 tool call 已 durable commit 后才能展示，且 request/response 各自不得超过 128 KiB；否则 UI 不应看到不可恢复的问题 (`packages/cli/src/services/SessionInteractionService.ts`)
- interaction 恢复不会重放原工具：它先用原 `toolCallId` 写带 provenance 的关闭结果，再把用户决定写入 inbox，最后提交 `interaction_recovered` (`packages/cli/src/services/SessionInteractionService.ts`)
- MCP elicitation 的 durable response 只保留 action、reason 与是否打开 URL，不保存表单 content；重启后若仍需要敏感字段必须重新请求 (`packages/cli/src/services/SessionInteractionService.ts`, `docs/reference/durable-pending-interactions.md`)
- 大 prompt 超过内联阈值后，JSONL/inbox 仅保存有界头尾、图片布局和 SHA-256 引用；artifact 缺失、被篡改、权限不为私有或 layout 不一致时必须在 Provider 前失败 (`packages/cli/src/agent/runtime/UserPromptArtifactStore.ts`)
- 旁路问答复制当前 messages 并使用独立 provider session ID，返回中的任何 tool call 都被拒绝；问题和答案都不进入主 transcript，也不能驱动主任务 (`packages/cli/src/services/SideConversationService.ts`, `git:761e85e9`)
- 用户 Shell 在活动 turn 中必须“先保存 JSONL，再以 persisted auxiliary steering 入队”；若 turn 已封口则进入下一 turn，不能发布完成事件后再补持久化 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `docs/reference/session-user-shell-command.md`)
- user shell 的 live stream 与最终 capture 是独立预算；binary 检测后只保留字节摘要，`completed` 事件还必须等待异步 output callback 全部 drain (`packages/cli/src/services/UserShellCommandService.ts`)

## Architecture
- ActiveTurnMailbox 用单个 transition mutex 管理 owner、sealed 和 claimed 集合，而 DurableSteeringInbox 用另一个 mutex 原子写 sidecar；前者处理运行时线性化，后者处理进程重启 (`packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`, `packages/cli/src/agent/runtime/DurableSteeringInbox.ts`)
- turn 生命周期以 `turn_started -> inbox_acknowledged + turn_completed|turn_aborted` 为 durable 边界；终态 receipt 只保存输入身份与有界执行指标，不复制 prompt 或 provider 错误 (`packages/cli/src/context/events/turnLifecycle.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)
- orphan tool recovery 先为每个未闭合 durable call 写 synthetic result，再关闭 active turn；已完成 child subagent 可在同一 validated batch 被 parent 采纳 (`packages/cli/src/context/storage/PersistentStore.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- SessionInteractionService 通过 `projectSessionInteractions()` 从 append-only request/response/recovery 事件计算 pending 与 recoverable 状态，并按 canonical project/session 键串行决策 (`packages/cli/src/context/interactions.ts`, `packages/cli/src/services/SessionInteractionService.ts`)
- 大 prompt artifact 以完整文本 hash 去重，图片仍内联并由 layout 保持原顺序；模型必须显式调用 `ReadPromptArtifact`，读取结果再作为普通 durable tool_result 进入历史 (`packages/cli/src/agent/runtime/UserPromptArtifactStore.ts`)

## Decisions
- 活动 turn steering 从进程内队列升级为 durable sidecar，并用 transcript acknowledgement 回收，以覆盖“已接纳但进程尚未消费”的崩溃窗口 (`packages/cli/src/agent/runtime/DurableSteeringInbox.ts`, `git:75d0e054`)
- final-ready、background completion 和 orphan tool 都采用 host-owned receipt 与幂等恢复，而不是重新调用 Provider 或工具，避免重复外部副作用 (`packages/cli/src/context/storage/PersistentStore.ts`, `git:b20220c0`)
- 用户交互将“请求可见”“回答生效”“恢复完成”拆成三次 fsync，牺牲少量事件数量换取任意崩溃点都可判定的状态 (`packages/cli/src/services/SessionInteractionService.ts`, `git:4416d8d8`)
- 超大用户请求放到 Session 私有 artifact，而不是简单截断或把宿主路径暴露给模型，使首轮输入有界且完整正文仍可验证获取 (`packages/cli/src/agent/runtime/UserPromptArtifactStore.ts`, `git:cae192bf`)

## Concurrency Model
- 每个 SessionRuntime 由跨进程 SessionLease 独占；每个 mailbox 的状态转换、每个 interaction key 和每个 user shell 分别串行，作用域不能扩大成全局锁 (`packages/cli/src/agent/runtime/SessionLease.ts`, `packages/cli/src/services/SessionInteractionService.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- ActiveOperationGate 关闭后拒绝新旁路操作、组合外部取消信号并等待所有 lease 显式 release；只 abort 而不 release 会让 shutdown 永久等待 (`packages/cli/src/agent/runtime/ActiveOperationGate.ts`)
- interaction keyed mutex 会在空闲后回收键状态，不能用永久 Map 替换，否则长运行 server 会按历史 Session 数增长 (`packages/cli/src/services/SessionInteractionService.ts`, `git:bd5f52c9`)

## Security Considerations
- prompt artifact 目录和文件分别强制 0700/0600，拒绝符号链接、错误 owner、非法 hash 名称和超配额内容；任何异常对外转换为不暴露宿主路径的固定错误 (`packages/cli/src/agent/runtime/UserPromptArtifactStore.ts`)
- user shell 使用 Session 冻结 cwd/env 和 owned process tree，取消或超时终止整棵树；显式 `!` 不走 Agent Bash permission，但也不会回退到其他 workspace (`packages/cli/src/services/UserShellCommandService.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- task failure 持久化为有限枚举和规范消息，不把 provider 原始错误正文、凭据或 admission identity 写入公开 metadata (`packages/cli/src/context/taskFailure.ts`)
