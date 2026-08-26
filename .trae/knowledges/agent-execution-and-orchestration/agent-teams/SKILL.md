---
name: knowledge-agent-execution-and-orchestration-agent-teams
description: >
  覆盖 Agent Team 创建、后台成员、共享任务依赖图、持久 mailbox、成员认领/完成和多端状态投影。
  进入时机：修改 TeamCreate/TeamStatus/TeamTaskClaim/SendMessage/TeamInbox、团队 owner
  鉴权、默认 worktree 隔离或团队 UI。不包含：通用子代理 resume 与 crash recovery
  （见 ../subagent-runtime/）。关键词：TeamRuntime, TeamStore, TeamTaskGraph,
  TeamMailbox, TeamCoordinator, team-lead, peer messaging。
---

## Module Structure

Agent Teams 在 durable 子代理之上增加团队身份、共享任务 DAG 和成员间消息；它不复制 Agent 执行器，而是组合 `BackgroundAgentManager` 与 `TaskListManager`。

### Directory Layout
- `packages/cli/src/agent/teams/` — 团队核心
  - `TeamRuntime.ts` — 创建、成员启动、鉴权、消息和状态投影
  - `TeamStore.ts` — 团队配置与 tombstone 持久化
  - `TeamTaskGraph.ts` — 通用任务列表到依赖图的投影
  - `TeamMailbox.ts` — durable 点对点/广播邮箱
  - `TeamCoordinator.ts` — 成员成功后的任务完成与解除阻塞
  - `TeamEvents.ts` — 跨表面事件契约
- `packages/cli/src/tools/builtin/team/` — 六个团队工具适配器
- `packages/cli/src/server/routes/team.ts` — Hono 团队 API 与 feature gate
- `packages/cli/web/src/components/chat/TeamPanel.tsx` — Web 成员、任务和消息面板
- `packages/cli/src/ui/components/TeamProgress.tsx` — TUI 团队进度投影

### Key Entry Points
- `TeamRuntime.create()` in `packages/cli/src/agent/teams/TeamRuntime.ts` — 持久化团队、任务并启动所有成员
- `TeamRuntime.claimTask()` in `packages/cli/src/agent/teams/TeamRuntime.ts` — 带 actor/owner 校验的原子认领
- `TeamRuntime.sendMessage()` in `packages/cli/src/agent/teams/TeamRuntime.ts` — durable 消息与即时 steering
- `TeamCoordinator.completeMemberWork()` in `packages/cli/src/agent/teams/TeamCoordinator.ts` — 成员成功后的任务图推进
- `createTeamTools()` in `packages/cli/src/tools/builtin/team/teamTools.ts` — Agent 可调用的团队能力集合

## Gotchas
- 团队成员不是任意并行 worker：每个成员都是绑定 lead session、canonical workspace、team ID 和共享 task-list ID 的后台子代理；缺任一身份时访问应按“team 不存在”失败，不能泄露跨会话团队 (`packages/cli/src/agent/teams/TeamRuntime.ts`, `packages/cli/src/agent/subagents/AgentSessionStore.ts`)
- `TeamCreate` 启动中途失败会取消已启动成员并把团队标为 deleted，但不会物理删除目录；同名再次创建会获得数字后缀而不是复用 tombstone 名称 (`packages/cli/src/agent/teams/TeamRuntime.ts`, `packages/cli/src/agent/teams/TeamStore.ts`)
- 任务依赖只能引用本次声明中更早的序号，这一限制在创建成员前校验并天然阻止前向依赖和环；绕过 `TeamRuntime` 直接写共享任务列表会失去该保证 (`packages/cli/src/agent/teams/TeamRuntime.ts`)
- 成员只有以 `completed + result.success=true` 结束时，协调器才自动完成其所有 `in_progress` 任务；failed/cancelled 成员留下的任务不会被伪装成完成 (`packages/cli/src/agent/teams/TeamCoordinator.ts`)
- 团队状态先看是否仍有 running 成员，因此“一个成员失败、另一个仍运行”仍显示 running；全部 worker 完成但任务图未全部完成时最终状态是 failed (`packages/cli/src/agent/teams/TeamRuntime.ts`)
- 未指定工具列表表示成员拥有全部工具，因此默认使用 worktree；显式只读工具集留在父 workspace，显式含 Edit/Write/ApplyPatch/Bash 的角色也默认 worktree (`packages/cli/src/agent/teams/TeamRuntime.ts`)
- teammate 不能创建嵌套 team，因为所有 child Agent 都被宿主强制 blacklist `TeamCreate`，不能只靠成员 prompt 中的约束 (`packages/cli/src/agent/subagents/BackgroundAgentManager.ts`, `packages/cli/src/agent/subagents/SubagentExecutor.ts`)
- `SendMessage` 先持久化 mailbox 再尝试注入目标成员 steering；只有 runtime 接受后才写 `deliveredAt`，因此离线或尚未启动的成员会在 `onStarted` 阶段补收 (`packages/cli/src/agent/teams/TeamRuntime.ts`, `packages/cli/src/agent/teams/TeamMailbox.ts`)
- `deliveredAt` 与 `acknowledgedAt` 是不同语义：即时注入只表示已投递，成员仍需通过 `TeamInbox` 显式确认；不能用其中一个字段替代另一个 (`packages/cli/src/agent/teams/TeamMailbox.ts`)
- 团队消息正文被包装成“不可信 teammate input”，不能授权工具或覆盖系统策略；接收者必须把它当协作数据而不是控制指令 (`packages/cli/src/agent/teams/TeamMailbox.ts`)
- `TeamDelete` 默认取消运行中的成员，但实现只写 `deletedAt`；Web/TUI 通过过滤 deleted 状态隐藏团队，磁盘记录仍保留用于审计 (`packages/cli/src/agent/teams/TeamRuntime.ts`, `packages/cli/web/src/components/chat/TeamPanel.tsx`)

## Architecture
- `TeamStore` 保存团队和成员静态定义，成员动态状态从 `AgentSessionStore` 投影，任务状态来自独立 `TaskListManager`，消息来自 mailbox；任何单一文件都不是完整团队快照 (`packages/cli/src/agent/teams/TeamStore.ts`, `packages/cli/src/agent/teams/TeamRuntime.ts`)
- 共享任务图使用 team name 作为 `taskListId`，`TeamTaskGraph` 只负责把通用 `pending/in_progress/completed` 转成 `pending/blocked/running/completed` 并计算反向依赖 (`packages/cli/src/agent/teams/TeamTaskGraph.ts`)
- 任务认领通过 `TaskListManager.claimNextAvailable()` 的进程内 keyed mutex、文件锁和原子写组合完成；候选必须未阻塞且未分配或已分配给当前成员，再按优先级和 ID 选择 (`packages/cli/src/tools/builtin/task/TaskListManager.ts`, `packages/cli/src/agent/teams/TeamTaskGraph.ts`)
- 团队事件始终发布到 lead SessionRef，TUI、Web 和 ACP 从同一事件/快照投影成员、任务和消息；成员自己的 LoopEvent 仍由子代理 bridge 负责 (`packages/cli/src/agent/teams/TeamEvents.ts`, `packages/cli/src/agent/teams/TeamRuntime.ts`)
- 团队完成由“所有 worker terminal + 所有任务 completed”共同决定，不以 lead 是否收到成员摘要作为完成依据 (`packages/cli/src/agent/teams/TeamRuntime.ts`)

## Decisions
- 团队层复用 durable subagent 和任务列表，而不是引入第二套执行器与 DAG 存储；这让进程恢复、Provider 准入和 worktree 交付沿用子代理语义 (`packages/cli/src/agent/teams/TeamRuntime.ts`, `packages/cli/src/agent/teams/TeamTaskGraph.ts`, `git:402cd82a`)
- mailbox 采用每团队单文件、`0600` 原子写和 keyed mutex，并设置 8 MiB 总上限与 32 KiB 单消息上限；超限时拒绝写入而不是截断协作消息 (`packages/cli/src/agent/teams/TeamMailbox.ts`)
- 团队工具虽然归类为 read-only 以便在受限模式中协调，但 `TeamCreate`、`SendMessage` 和 `TeamDelete` 都有 durable 副作用，因此并发安全分别显式标注而不依赖 ToolKind 推断 (`packages/cli/src/tools/builtin/team/teamTools.ts`)

## Patterns
- 成员 prompt 固定注入团队目的、共享 task graph、workspace 和 peer-messaging 状态，并要求任务完成后原子认领下一项；角色自己的 system prompt 仍由 Subagent 配置提供 (`packages/cli/src/agent/teams/TeamRuntime.ts`)
- `TeamTaskClaim` 和 `TeamInbox` 可从 teammate 的 `ExecutionContext.taskListId/sessionId` 推断身份，lead 或 HTTP 调用则必须显式提供 owner 信息 (`packages/cli/src/tools/builtin/team/teamTools.ts`, `packages/cli/src/server/routes/team.ts`)
- Web 面板只在 feature 开启、存在当前 SessionRef 且拥有非空团队列表时渲染；deleted team 在状态源和界面两层过滤，刷新后仍从 durable 快照恢复 (`packages/cli/web/src/components/chat/TeamPanel.tsx`, `packages/cli/src/agent/teams/TeamRuntime.ts`)
