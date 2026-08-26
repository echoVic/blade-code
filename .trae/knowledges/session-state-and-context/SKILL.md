---
name: knowledge-session-state-and-context
description: >
  覆盖会话状态所有权、持久事件、读侧投影、历史分叉/回退、活动轮次恢复及模型上下文压缩。
  适用于修改 Session 生命周期、JSONL/CQRS、resume/fork/rewind、steering、Token 预算或项目记忆。
  不含 Agent 决策循环（见 ../agent-execution-and-orchestration/）和工具执行机制（见 ../tool-and-automation-platform/）。
  关键词：SessionRuntime, SessionService, PersistentStore, SessionEventLog, JSONL, CQRS, compaction, rewind, steering。
---

## Module Structure

该域负责把一次会话的权威事实、活动运行时与各端读模型分开：持久事实进入 JSONL，运行时持有互斥与恢复状态，TUI/Web/ACP 从相同事实投影，模型上下文则可在不破坏完整历史的前提下压缩。

### Directory Layout
- `packages/cli/src/context/`：事件模型、持久存储、上下文组装、压缩与 Token 预算
- `packages/cli/src/agent/runtime/`：Session 所有权、活动轮次 mailbox、恢复和私有 artifact
- `packages/cli/src/services/SessionService.ts`：会话目录、加载、分叉、回退、归档与导出编排
- `packages/cli/src/services/SessionInteractionService.ts`：持久交互请求、响应和崩溃恢复
- `packages/cli/src/memory/`：跨会话项目记忆与压缩后巩固

### Key Entry Points
- `SessionRuntime.initialize()` in `packages/cli/src/agent/runtime/SessionRuntime.ts`：获取会话所有权并执行恢复
- `PersistentStore` in `packages/cli/src/context/storage/PersistentStore.ts`：将领域动作转换为有序事件
- `SessionService` in `packages/cli/src/services/SessionService.ts`：面向 CLI、Web 与 ACP 的持久会话服务
- `CompactionService.compact()` in `packages/cli/src/context/CompactionService.ts`：生成并约束模型可见替换上下文

## Gotchas
- `sessionId` 不是全局身份；省略 `projectPath` 的查找可能因多个工作区同名而拒绝，跨端路由必须保持 `sessionId + canonical projectPath` 复合身份 (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/server/sessionRef.ts`)
- Runtime、TUI store、Web store 和 SQLite 都不是持久真相，修复恢复问题时必须从 materialized JSONL 重新推导，不能把某个内存快照写回当作权威 (`packages/cli/src/context/storage/PersistentStore.ts`, `packages/cli/src/context/storage/sqlite/projection.ts`)
- rewind 与 compaction 都保留原始 transcript：前者通过 `session_rewound` 改变有效事件，后者通过 replacement checkpoint 改变模型可见上下文；直接截断 JSONL 会同时破坏审计、导出和断点续传 (`packages/cli/src/services/sessionRewind.ts`, `packages/cli/src/services/SessionService.ts`)
- durable inbox、prompt artifact 等 sidecar 不是独立会话真相；它们必须通过 transcript 中的 acknowledgement、message metadata 或生命周期事件对账后才能删除或重放 (`packages/cli/src/agent/runtime/DurableSteeringInbox.ts`, `packages/cli/src/agent/runtime/UserPromptArtifactStore.ts`)
- 会话恢复必须先取得 `SessionLease` 再修复 orphan 进程、工具调用和 turn；颠倒顺序会让两个进程同时“恢复”同一条父链 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/agent/runtime/SessionLease.ts`, `git:46145c53`)

## Architecture
- 写路径为 `SessionRuntime/SessionService -> ContextManager/PersistentStore -> SessionEventLog -> JSONLStore`，事件落盘并取得 seq 后才允许发布给各 surface (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/context/ContextManager.ts`, `packages/cli/src/context/events/SessionEventLog.ts`)
- 读路径有三种不同投影：完整可见历史供 UI/导出，replacement checkpoint 之后的上下文供模型，SQLite materialization 供目录与搜索；三者不能互相替代 (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/context/storage/sqlite/projection.ts`)
- 活动轮次采用“双账本”恢复：inbox 保存尚未确认的输入，JSONL 保存 turn/tool/interaction 事实；启动时通过 message ID 和终态 receipt 对账形成 exactly-once continuation (`packages/cli/src/agent/runtime/DurableSteeringInbox.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)
- 跨端一致性依赖同一事件语义而非同一 UI reducer：TUI 使用共享 conversation reducer，Web 消费 SSE 投影，ACP 消费顺序化 update，但都以已提交 JSONL 生命周期为恢复边界 (`packages/cli/src/store/slices/sessionSlice.ts`, `packages/cli/web/src/store/session/handlers/eventHandlers.ts`, `packages/cli/src/acp/Session.ts`)

## Decisions
- 项目从多套 surface 事件系统收敛为 append-only committed events 加 ephemeral deltas，以换取可重放、可断点续传和持久化先于可见性的统一契约 (`packages/cli/src/context/events/SessionEventLog.ts`, `git:c776d496`)
- SQLite 被刻意定义为可删除、可重建、失败开放的读缓存，而不是第二写模型，因此绕过 event log 的历史写入仍能被拉取式同步捕获 (`packages/cli/src/context/storage/sqlite/projection.ts`, `git:1f856671`)
- ContextManager 已从状态容器收缩为 PersistentStore 的薄门面，压缩、过滤和记忆均由独立服务拥有，新增上下文行为不应重新塞回 ContextManager (`packages/cli/src/context/ContextManager.ts`, `git:a074815b`)

## Conventions
- 需要“只允许一个胜者”的生命周期转换使用 `commitValidated` 或 `commitValidatedBatch`，在同一 per-file 队列内读取最新事实、校验并追加 (`packages/cli/src/context/events/SessionEventLog.ts`, `packages/cli/src/context/storage/JSONLStore.ts`)
- 所有恢复与目录聚合先调用 `materializeSessionEvents()`，确保历史中的多次 rewind 按顺序生效后再计算 turn、interaction、搜索或 metadata (`packages/cli/src/services/sessionRewind.ts`, `packages/cli/src/services/SessionService.ts`)
- UI 可见性、模型可见性和持久性是三个独立维度；例如 token handoff 可持久但不对客户端广播，delta 可广播但不持久 (`packages/cli/src/context/TokenBudgetHandoff.ts`, `packages/cli/src/context/events/SessionEventLog.ts`)

## Child Knowledge Nodes
- `./durable-transcript-and-event-projection/SKILL.md`：修改 JSONL 提交、seq、replay、SQLite 或 TUI/Web 事件投影时进入
- `./session-catalog-fork-rewind-and-export/SKILL.md`：修改目录分页、归档、恢复、分叉、回退、搜索或 Markdown 导出时进入
- `./active-turn-interactions-and-recovery/SKILL.md`：修改 turn 互斥、steering、持久交互、崩溃恢复、旁路问答或用户 Shell 时进入
- `./context-compaction-token-budget-and-memory/SKILL.md`：修改上下文组装、压缩策略、Token handoff、工具结果预算或 Auto Memory 时进入
