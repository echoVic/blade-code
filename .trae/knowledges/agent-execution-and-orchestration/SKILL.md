---
name: knowledge-agent-execution-and-orchestration
description: >
  覆盖 Blade 的 Agent 决策执行、子代理、Agent Teams、Goal、任务列表与定时任务编排。
  进入时机：修改 Agent loop、完成门禁、Task 委派、团队协作、Goal 状态机或任务调度。
  不包含：会话事件与恢复细节（见 ../session-state-and-context/）、工具执行内部管线（见
  ../tool-and-automation-platform/）。关键词：Agent, executeLoopGenerator, Task,
  Subagent, Agent Teams, GoalStore, TaskScheduler, SessionTaskService。
---

## Module Structure

该域负责把一次用户意图推进为可持久恢复、可委派、可验证的 Agent 工作；会话状态和具体工具副作用由相邻领域提供，本域只编排它们。

### Directory Layout
- `packages/cli/src/agent/` — 无状态 Agent 外壳、决策循环、子代理和团队运行时
  - `loop/` — Provider 回合、工具调度、完成门禁和持久化边界
  - `subagents/` — 子代理配置、执行、恢复、结果采纳和 worktree 生命周期
  - `teams/` — 团队成员、任务图、邮箱和状态投影
  - `runtime/` — 本域使用的任务与定时调度器
- `packages/cli/src/goals/` — 持久 Goal 状态机、延续提示和完成验证记录
- `packages/cli/src/prompts/` — 系统提示组装与运行模式指令
- `packages/cli/src/services/CodeReviewService.ts` — 只读审查会话编排
- `packages/cli/src/services/SessionTaskService.ts` — 独立任务 Session 与隔离 worktree 创建

### Key Entry Points
- `Agent.chatStream()` in `packages/cli/src/agent/Agent.ts` — 各运行表面的统一 Agent 事件流入口
- `executeLoopGenerator()` in `packages/cli/src/agent/loop/executeLoopGenerator.ts` — Provider、工具和完成门禁的核心循环
- `createTaskTool()` in `packages/cli/src/tools/builtin/task/task.ts` — 子代理前台、后台与恢复入口
- `TeamRuntime.create()` in `packages/cli/src/agent/teams/TeamRuntime.ts` — 团队和成员启动入口
- `GoalStore` in `packages/cli/src/goals/GoalStore.ts` — Goal 持久状态机
- `SessionTaskService.createSessionTask()` in `packages/cli/src/services/SessionTaskService.ts` — 顶层任务 Session 创建入口

## Gotchas
- “Task”在本域有三套不同身份：`Task` 工具启动子代理，`TaskListManager` 保存 Agent 内检查清单，`SessionTaskService` 创建可在看板和调度器中运行的顶层 Session；三者不能共用 ID 或生命周期假设 (`packages/cli/src/tools/builtin/task/task.ts`, `packages/cli/src/tools/builtin/task/TaskListManager.ts`, `packages/cli/src/services/SessionTaskService.ts`)
- Goal、任务列表和团队工具被声明为 `ToolKind.ReadOnly` 只表示工具权限分类，不表示无副作用；它们会写 sidecar、启动子代理或改变 durable 状态 (`packages/cli/src/tools/builtin/goal/goalTools.ts`, `packages/cli/src/tools/builtin/task/taskListTools.ts`, `packages/cli/src/tools/builtin/team/teamTools.ts`)
- `Agent.executeTask()` 只是一次直接模型调用，不经过工具循环、完成门禁或 durable turn 协议；需要完整编排行为的调用方必须走 `chatStream()`/`chat()` (`packages/cli/src/agent/Agent.ts`, `packages/cli/src/agent/ExecutionEngine.ts`)
- 子代理、团队成员和定时任务最终都复用 Session Runtime，但各自另有 sidecar；只修复主 Session transcript 不会自动修复这些编排状态 (`packages/cli/src/agent/subagents/AgentSessionStore.ts`, `packages/cli/src/agent/teams/TeamStore.ts`, `packages/cli/src/services/ScheduleStore.ts`)

## Architecture
- `Agent` 保存模型与工具依赖，不保存 session ID 或消息历史；每次调用从 `ChatContext` 取状态，存在 Session 时再由 `SessionRuntime` 提供资源快照、持久化和活动轮次所有权 (`packages/cli/src/agent/Agent.ts`)
- Goal 完成不是独立于 Agent loop 的按钮操作：`UpdateGoal complete` 只生成候选，loop 强制启动保留的 `goal-verification` 子代理，PASS 后才由宿主最终提交 (`packages/cli/src/agent/loop/goalCompletionVerification.ts`, `packages/cli/src/goals/GoalStore.ts`, `git:0eff1b2a`)
- Agent Teams 是子代理运行时和共享任务列表之上的组合层，而不是另一套 Agent 实现；成员由 `BackgroundAgentManager` 执行，依赖图复用 `TaskListManager` (`packages/cli/src/agent/teams/TeamRuntime.ts`, `packages/cli/src/agent/teams/TeamTaskGraph.ts`)
- 定时任务不直接执行模型请求；`TaskScheduler` 调用与 Web/CLI 任务相同的 `dispatchTask` 路径，因此继承顶层任务的准入、隔离、恢复和事件投影 (`packages/cli/src/agent/runtime/TaskScheduler.ts`, `packages/cli/src/services/SessionTaskService.ts`, `git:675b11bc`)
- 子代理生命周期、团队事件、Goal 更新和任务列表更新最终汇入统一 Loop/Bus 事件，再由 TUI、Web、Headless 与 ACP 投影；新增状态不能只更新某一个界面 (`packages/cli/src/agent/loop/types.ts`, `packages/cli/src/agent/loop/toolDomainPolicy.ts`, `packages/cli/src/agent/teams/TeamEvents.ts`)

## Decisions
- 编排状态按恢复边界拆成独立存储：对话走 Session JSONL，子代理走 agent sidecar，Goal、团队、任务列表和 schedule 各自原子写入；这样各状态机可以独立校验和恢复，代价是跨文件完成必须携带可核对 receipt (`packages/cli/src/agent/loop/conversationPersistence.ts`, `packages/cli/src/agent/subagents/AgentSessionStore.ts`, `packages/cli/src/goals/GoalStore.ts`)
- 文件系统隔离由任务或子代理启动层创建并交给子 Session，Agent loop 只观察 workspace 转换和完成证据；不要在 loop 内另建 worktree 生命周期 (`packages/cli/src/services/SessionTaskService.ts`, `packages/cli/src/agent/subagents/SubagentWorktreeLifecycle.ts`, `packages/cli/src/agent/loop/toolDomainPolicy.ts`)

## Patterns
- 所有可恢复的委派都先生成稳定 child Session ID，再把 lineage、owner 和配置快照持久化；完成结果通过同一身份回接父会话，避免按显示名称猜测归属 (`packages/cli/src/agent/loop/durableToolIdentity.ts`, `packages/cli/src/agent/subagents/AgentSessionStore.ts`)
- 对外表面只消费事件和快照，不直接拥有编排状态；状态刷新或重启后的投影应重新读取 durable source，而不是缓存 UI 组件内部状态 (`packages/cli/src/agent/loop/types.ts`, `packages/cli/src/agent/teams/TeamRuntime.ts`, `packages/cli/src/services/ScheduleStore.ts`)

## Child Knowledge Nodes
- `./decision-loop-and-completion/SKILL.md` — 进入时机：修改流式决策循环、工具回合、持久提交顺序、完成门禁、系统提示或结构化输出
- `./subagent-runtime/SKILL.md` — 进入时机：修改子代理发现、前后台执行、resume lineage、结果采纳、只读验证代理或隔离 worktree
- `./agent-teams/SKILL.md` — 进入时机：修改团队创建、成员状态、共享任务图、邮箱通信、认领/完成流程或多端投影
- `./goals-tasks-and-scheduling/SKILL.md` — 进入时机：修改 Goal 状态机、Agent 任务列表、顶层任务 Session、定时触发或任务交付
