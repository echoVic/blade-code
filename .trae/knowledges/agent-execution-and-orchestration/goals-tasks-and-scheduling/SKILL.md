---
name: knowledge-agent-execution-and-orchestration-goals-tasks-and-scheduling
description: >
  覆盖持久 Goal 状态机、Agent 内任务列表、顶层任务 Session、worktree 交付和
  cron/interval/once 定时调度。进入时机：修改 Goal 完成验证、TaskCreate/TaskUpdate、
  Task Home/Kanban、SessionTaskService、ScheduleStore 或 TaskScheduler。不包含：子代理
  Task 工具与 resume（见 ../subagent-runtime/）、团队专用任务图（见 ../agent-teams/）。
  关键词：GoalStore, UpdateGoal, TaskListManager, SessionTaskService, TaskScheduler,
  ScheduleStore, schedule, kanban, misfire。
---

## Module Structure

该节点包含三类不同的“持续工作”：每 Session 一个长期 Goal、供 Agent/团队协调的轻量任务列表，以及由 Web/CLI/调度器创建并独立运行的顶层任务 Session。

### Directory Layout
- `packages/cli/src/goals/` — Goal sidecar、状态机、提前停止检测和 continuation prompt
- `packages/cli/src/agent/runtime/TaskScheduler.ts` — `blade serve` 拥有的定时扫描与 dispatch
- `packages/cli/src/agent/runtime/scheduleTiming.ts` — cron、interval、once 解析与下次执行计算
- `packages/cli/src/services/ScheduleStore.ts` — 全局 schedule JSON 存储
- `packages/cli/src/services/SessionTaskService.ts` — 顶层任务 Session 与 worktree 创建
- `packages/cli/src/tools/builtin/goal/` — Goal 查询、创建和完成候选工具
- `packages/cli/src/tools/builtin/task/` — Agent 任务列表与子代理 Task 入口
- `packages/cli/src/commands/schedule.ts` — CLI schedule 管理与远程手动触发
- `packages/cli/src/server/routes/task.ts` — 顶层任务创建、更新、重试、diff 与交付 API
- `packages/cli/src/server/routes/schedule.ts` — schedule CRUD 与手动运行 API
- `packages/cli/web/src/components/tasks/`, `packages/cli/web/src/components/kanban/`, `packages/cli/web/src/components/schedules/` — Web 任务与调度表面

### Key Entry Points
- `GoalStore.create()` / `GoalStore.requestCompletion()` in `packages/cli/src/goals/GoalStore.ts` — Goal 启动与完成候选
- `GoalStore.finalizeVerifiedCompletion()` in `packages/cli/src/goals/GoalStore.ts` — 宿主授权的最终完成
- `TaskListManager.mutate()` in `packages/cli/src/tools/builtin/task/TaskListManager.ts` — 任务列表串行读改写
- `SessionTaskService.createSessionTask()` in `packages/cli/src/services/SessionTaskService.ts` — 顶层任务和隔离 workspace 创建
- `TaskScheduler.tick()` / `TaskScheduler.fire()` in `packages/cli/src/agent/runtime/TaskScheduler.ts` — 定时触发与账本推进
- `computeNextRun()` in `packages/cli/src/agent/runtime/scheduleTiming.ts` — 三类 trigger 的统一时间计算

## Gotchas
- `UpdateGoal({status:"complete"})` 只把状态改为 `verifying` 并增加 attempt；必须存在 fresh verifier Session ID 和 SHA-256 evidence digest 的 PASS，宿主才允许 `complete` (`packages/cli/src/tools/builtin/goal/goalTools.ts`, `packages/cli/src/goals/GoalStore.ts`, `git:0eff1b2a`)
- reserved verifier 的启动本身证明宿主已持久接受 completion candidate；审计期间的 `verifying/pending` 是等待该 verifier verdict 的必要中间态，不能被解释成执行 Agent 未调用 `UpdateGoal complete`，但也不能替代对实际交付物的验证 (`packages/cli/src/agent/loop/goalCompletionVerification.ts`, `packages/cli/src/agent/subagents/builtinGoalVerificationAgent.ts`)
- Goal 已有 PASS 后发生 workspace mutation、用户 steering 或 Stop hook continuation 会使证据失效；进程重启也不信任没有 exact finalization receipt 的旧 PASS (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `docs/reference/goal-completion-verification.md`)
- Goal 最终 assistant commit 与 sidecar 完成不是一个文件事务；恢复只在 goal ID、attempt、verifier ID、evidence digest 和 goal revision 全匹配 receipt 时幂等补写 complete (`packages/cli/src/goals/GoalStore.ts`, `docs/reference/goal-completion-verification.md`, `git:ebd505c9`)
- 同一脱敏 verifier 反馈连续 3 次会把 Goal 置为 blocked；不同反馈重置计数，PASS、编辑或显式 resume 清除 stall 状态 (`packages/cli/src/goals/GoalStore.ts`, `packages/cli/src/goals/types.ts`, `git:490df8c5`)
- premature-stop 只检查最终非空段落中一组保守的英文起始模式；同一模式连续 3 次才自动 blocked，模式改变会从 1 重新计数 (`packages/cli/src/goals/prematureStop.ts`, `packages/cli/src/goals/GoalStore.ts`)
- Goal token 使用按每次 continuation 的 run metadata 累加，达到显式预算立即进入 `budget_limited`；结束一个模型回合不会隐式暂停或完成 Goal (`packages/cli/src/agent/Agent.ts`, `packages/cli/src/goals/GoalStore.ts`)
- 通用 TaskList 的状态流转主要由工具提示约束，存储层允许直接设置任一合法状态；调用方若绕过 `pending → in_progress → completed`，不会由 `TaskListManager` 自动拒绝 (`packages/cli/src/tools/builtin/task/taskListTools.ts`, `packages/cli/src/tools/builtin/task/TaskListManager.ts`)
- 通用 TaskList 可添加不存在的 `blockedBy` ID，结果会永久不可认领；Team 创建路径额外要求依赖只能引用更早任务，不能假设这个校验存在于底层 manager (`packages/cli/src/tools/builtin/task/TaskListManager.ts`, `packages/cli/src/agent/teams/TeamRuntime.ts`)
- Schedule 只有 `blade serve` 内的 `TaskScheduler` 会自动触发；CLI 只读写共享文件，`blade schedule run` 也必须调用正在运行的 server (`packages/cli/src/commands/schedule.ts`, `packages/cli/src/agent/runtime/TaskScheduler.ts`)
- 同一 schedule 的 overlap 防护和 tick 重入锁都只在当前 server 进程内；`ScheduleStore` 的写链也只保证进程内串行，多个进程同时管理 schedule 仍是 last-writer-wins (`packages/cli/src/agent/runtime/TaskScheduler.ts`, `packages/cli/src/services/ScheduleStore.ts`)
- dispatch 抛错仍会推进 recurring 的下一次时间，once 则消费唯一机会并停用；错误路径不增加 `runCount`，因此该字段统计成功 dispatch 而不是所有尝试 (`packages/cli/src/agent/runtime/TaskScheduler.ts`)
- 手动运行 recurring schedule 保留原 `nextRunAt`，不会把 cadence 从手动触发时刻重新锚定；手动运行 once 仍会将其停用 (`packages/cli/src/agent/runtime/TaskScheduler.ts`)
- `ScheduleStore` 对缺失或损坏文件都返回空列表并记录 warning；后续写操作可能以空集合覆盖损坏内容，诊断数据丢失前应先检查日志与原文件 (`packages/cli/src/services/ScheduleStore.ts`)
- `parseIntervalMs()` 接受秒级输入，但持久 schedule 的 `validateTrigger()` 要求至少 60 秒；只调用解析器通过不代表 trigger 可创建 (`packages/cli/src/agent/runtime/scheduleTiming.ts`)

## Architecture
- Goal sidecar 由 Session/workspace 共同分区并使用 keyed mutex、原子 fsync 写；监听器在持久化后通知，观察者异常被吞掉且不能回滚已提交状态 (`packages/cli/src/goals/GoalStore.ts`)
- Goal continuation 由 `Agent.chatStream()` 在普通 follow-up 耗尽后自动开启，重新加载 durable snapshot、累计用量并注入 objective/验证反馈；没有固定 continuation 上限 (`packages/cli/src/agent/Agent.ts`, `packages/cli/src/goals/prompts.ts`)
- TaskList 同时使用进程内 keyed mutex 和 `proper-lockfile` 跨进程锁，再原子替换 JSON；Team task graph 复用相同存储，所以普通任务工具与 teammate claim 可以安全共享列表 (`packages/cli/src/tools/builtin/task/TaskListManager.ts`, `packages/cli/src/tools/builtin/task/TaskListFileLock.ts`)
- 顶层任务由 `SessionTaskService` 先可选创建 worktree，再写 Session metadata；metadata 创建失败会移除刚建的 worktree并丢弃其中状态，避免留下无主隔离目录 (`packages/cli/src/services/SessionTaskService.ts`)
- Scheduler 只负责发现到期项和调用注入的 `dispatchTask`；任务终态通过全局 `task.status` Bus 事件异步回写 schedule，因此 `schedule.fired` 的初始 status 可能仍是 queued/running (`packages/cli/src/agent/runtime/TaskScheduler.ts`)
- 定时触发统一创建顶层任务 Session，默认 worktree + default permission mode；schedule 自身不持有 Agent Runtime、队列 permit 或执行日志 (`packages/cli/src/agent/runtime/TaskScheduler.ts`, `packages/cli/src/services/ScheduleStore.ts`)

## Decisions
- Goal 完成权归宿主持有而不是交给执行模型：内置 `goal-verification` 以只读、fresh、结构化 verdict 检查持久 objective，避免模型仅凭自述结束长期目标 (`packages/cli/src/agent/loop/goalCompletionVerification.ts`, `packages/cli/src/agent/subagents/builtinGoalVerificationAgent.ts`)
- TaskList 的依赖边在写入时双向同步，删除任务也会清除其他任务的 `blocks/blockedBy`；认领阶段只信完成集合，不维护额外派生索引 (`packages/cli/src/tools/builtin/task/TaskListManager.ts`)
- schedule 使用单个全局 JSON 文件服务所有项目，每条记录显式绑定 `projectPath`；这是低频控制面的简单持久化选择，不具备跨进程事务语义 (`packages/cli/src/services/ScheduleStore.ts`)
- cron 采用标准 5 段且 DOM/DOW 同时受限时按 OR 匹配，星期日 0/7 归一；下一次运行按分钟扫描最多 4 年，无法命中时返回 null (`packages/cli/src/agent/runtime/scheduleTiming.ts`)

## Patterns
- Goal 所有状态更新都在同一文件锁内执行“读取最新状态 → schema 校验 → 原子持久化 → 发布副本”，调用方不应缓存 snapshot 后自行合并 (`packages/cli/src/goals/GoalStore.ts`)
- TaskList 每次 mutation 都重读磁盘并保持单调 `nextId`；旧数组格式可迁移读取，重复 ID 或任一非法 task 会让整个列表 fail closed (`packages/cli/src/tools/builtin/task/TaskListManager.ts`)
- recurring schedule 离线错过多个 slot 时只补跑一次，并从当前触发时刻计算下一次；同一个 tick 顺序 await 各 schedule，避免调度器自身形成无界并发 (`packages/cli/src/agent/runtime/scheduleTiming.ts`, `packages/cli/src/agent/runtime/TaskScheduler.ts`)

## Scheduling Boundaries
- cron 创建时若未给 timezone 会冻结当前系统 IANA timezone；匹配时通过 `Intl.DateTimeFormat` 投影目标时区，不能把 schedule 当成固定 UTC 偏移 (`packages/cli/src/services/ScheduleStore.ts`, `packages/cli/src/agent/runtime/scheduleTiming.ts`)
- 普通 `ScheduleStore.create()` 将 `expiresAt` 设为 null；7 天 expiry helper 只供另行设置的有界 recurring 调用使用，server-owned schedule 不会仅因创建满 7 天自动过期 (`packages/cli/src/services/ScheduleStore.ts`, `packages/cli/src/agent/runtime/scheduleTiming.ts`)
- 启用一个曾停用的 schedule 会从当前时间重算 `nextRunAt`，但单纯修改 prompt、模型或权限不会改变 cadence (`packages/cli/src/services/ScheduleStore.ts`)
