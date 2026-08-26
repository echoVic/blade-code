---
name: knowledge-agent-execution-and-orchestration-subagent-runtime
description: >
  覆盖子代理定义发现、前后台 Task 执行、durable resume lineage、结果采纳、验证代理和
  managed worktree 生命周期。进入时机：新增 agent Markdown、修改 Task/TaskOutput、
  调试后台完成通知、进程重启恢复、resume 或子代理隔离。不包含：团队任务图与成员邮箱
  （见 ../agent-teams/）。关键词：SubagentRegistry, SubagentExecutor,
  BackgroundAgentManager, AgentSessionStore, resume_from, verification, worktree。
---

## Module Structure

子代理是拥有独立 SessionRuntime、transcript 和 sidecar 的 child run；`Task` 工具负责身份与调用契约，执行器负责运行，后台管理器负责持久状态、通知和崩溃恢复。

### Directory Layout
- `packages/cli/src/agent/subagents/` — 注册表、执行器、sidecar、恢复、结果采纳和内置代理
  - `SubagentRegistry.ts` — Markdown/frontmatter 配置加载和优先级
  - `SubagentExecutor.ts` — 独立 child SessionRuntime 执行
  - `BackgroundAgentManager.ts` — 后台运行、等待、取消、resume 和 orphan reconciliation
  - `AgentSessionStore.ts` — durable sidecar 与 lineage/config snapshot
  - `SubagentWorktreeLifecycle.ts` — 隔离 worktree 准备与收尾
  - `SubagentResultAdoption.ts` — 父 Task 缺失结果时的重启采纳
  - `BackgroundSubagentCompletion.ts` — 后台终态通知构造
- `packages/cli/src/tools/builtin/task/task.ts` — Task 工具前台、后台和 resume 协议
- `packages/cli/src/cli/agents.ts` — `--agents` 单次运行定义严格解析
- `packages/cli/src/slash-commands/agents.ts` — TUI agent 管理入口
- `.claude/agents/` — Git 可见的 Claude Code 兼容 agent 定义
- `docs/guides/subagents.md` — 用户可见配置与恢复契约

### Key Entry Points
- `createTaskTool()` in `packages/cli/src/tools/builtin/task/task.ts` — 模型侧委派入口
- `SubagentRegistry.loadFromStandardLocations()` in `packages/cli/src/agent/subagents/SubagentRegistry.ts` — 分层资源发现
- `SubagentExecutor.execute()` in `packages/cli/src/agent/subagents/SubagentExecutor.ts` — 直接前台执行器
- `BackgroundAgentManager.startBackgroundAgent()` in `packages/cli/src/agent/subagents/BackgroundAgentManager.ts` — durable 后台 child 启动
- `BackgroundAgentManager.resumeAgent()` in `packages/cli/src/agent/subagents/BackgroundAgentManager.ts` — immutable child resume

## Gotchas
- `resume_from` 不会复用原 agent ID，而会创建新的 child run；源运行必须已终止、类型必须一致，并记录 `rootAgentId → resumedFrom → resumeDepth`，否则恢复被拒绝 (`packages/cli/src/tools/builtin/task/task.ts`, `packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
- resume 使用源 sidecar 中冻结的模型、权限、工具、系统提示、最大回合和隔离配置，不重新读取同名 agent 的最新定义；修改配置不会改变既有 lineage (`packages/cli/src/agent/subagents/AgentSessionStore.ts`, `packages/cli/src/agent/subagents/BackgroundAgentManager.ts`, `git:888d608f`)
- 子代理访问权按 `parent sessionId + canonical projectPath` 复合校验；只有相同 session ID 不足以跨 workspace 查询、取消、采纳或恢复 child (`packages/cli/src/agent/subagents/AgentSessionStore.ts`, `packages/cli/src/tools/builtin/task/task.ts`)
- 子 Agent 的 blacklist 总会加入 `EnterWorktree`、`ExitWorktree` 和 `TeamCreate`；隔离 worktree 由宿主生命周期创建，teammate 也不能嵌套创建团队 (`packages/cli/src/agent/subagents/SubagentExecutor.ts`, `packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
- 隔离运行只有“成功且无改动、无提交”才自动删除 worktree；失败或任何变更都会保留路径与分支，调用方必须按交付语义处理 (`packages/cli/src/agent/subagents/SubagentWorktreeLifecycle.ts`)
- 后台完成通知只内联最多 32,000 字符结果和 8,000 字符错误，并明确标为不可信数据；需要完整 durable 结果时才调用 `TaskOutput`，不能通过高频轮询代替 completion push (`packages/cli/src/agent/subagents/BackgroundSubagentCompletion.ts`, `packages/cli/src/tools/builtin/task/task.ts`)
- orphan child 只有在 durable turn 已 `turn_completed` 且恢复上下文中存在最终 assistant 文本时才恢复为 completed；其他情况记为 interrupted failed 并允许用新 ID resume (`packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
- running sidecar 同时保存 PID 和进程启动身份，防止 PID 复用被误判为原 owner 仍存活；旧记录缺身份时采用更保守的兼容窗口 (`packages/cli/src/agent/subagents/AgentSessionStore.ts`, `packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
- 父 transcript 中缺失前台 Task 结果时，只有 child ID、owner、description、显式 type、resume lineage 和终态结果全部匹配才会采纳；后台 child 或 cancelled child 不走该路径 (`packages/cli/src/agent/subagents/SubagentResultAdoption.ts`, `git:103e57b7`)
- `verification` 与 `goal-verification` 是保留名称，用户、项目和命令行 override 都不能覆盖；普通内置 agent 则允许被后续高优先级来源替换 (`packages/cli/src/agent/subagents/SubagentRegistry.ts`)

## Architecture
- 每个 child 创建独立 `SessionRuntime` 和 `Agent`，继承父 Session 冻结的 agent/model/LSP 资源及 Provider admission owner，但使用自己的 session ID、transcript 和取消边界 (`packages/cli/src/agent/subagents/SubagentExecutor.ts`, `packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
- Task 前台和后台路径共享相同 canonical 终态结果构造器；结果 metadata 承载 lineage、验证证据、修改文件与 worktree 信息，避免各表面自行解释 child sidecar (`packages/cli/src/agent/subagents/SubagentResultAdoption.ts`, `packages/cli/src/tools/builtin/task/task.ts`)
- 后台 child 先提交 terminal sidecar，再由父 Runtime 校验并写入 client-hidden inbox receipt；父 Agent 在安全边界消费该消息并继续，而不是把后台回调直接拼进当前模型输出 (`packages/cli/src/agent/subagents/BackgroundSubagentCompletion.ts`, `packages/cli/src/agent/Agent.ts`, `git:aa5060a7`)
- `Task` 工具声明 `parallelism: shared` 以支持同一模型响应批量委派，但不在流式预启动 allowlist；child 只会在父 tool-call durable identity 建立后启动 (`packages/cli/src/tools/builtin/task/task.ts`, `packages/cli/src/agent/loop/StreamingToolExecutor.ts`)
- 子代理 LoopEvent 经 bridge 同时更新本地 progress store 和父 Session Bus；终态事件只发送一次，后台路径随后再触发 durable completion notification (`packages/cli/src/tools/builtin/task/task.ts`)

## Decisions
- 配置覆盖顺序为内置、Claude 用户级、受信 Claude 项目级、Blade 用户级、受信 Blade 项目级，最后是 invocation `--agents`；项目来源受 Workspace Trust 限制 (`packages/cli/src/agent/subagents/SubagentRegistry.ts`, `packages/cli/src/cli/agents.ts`)
- Agent sidecar 使用 schema v2、`0600` 原子 fsync 写入和 `0700` 目录；公开投影刻意排除 prompt、消息、配置快照、workspace 与进程身份 (`packages/cli/src/agent/subagents/AgentSessionStore.ts`)
- 终态 sidecar 缓存上限为 256，淘汰时跳过 running session；这是为了限制长驻 server 内存，同时不丢失活跃 child 的协调状态 (`packages/cli/src/agent/subagents/AgentSessionStore.ts`, `git:8887f958`)
- 内置独立验证代理优先使用宿主提供的 JSON Schema verdict，兼容路径也只接受恰好一个固定 verdict 标题；修改文件与成功验证命令由工具 metadata 采集 (`packages/cli/src/agent/subagents/builtinVerificationAgent.ts`, `packages/cli/src/agent/subagents/SubagentExecutor.ts`)

## Patterns
- fresh Task 必须显式给 `subagent_type`，resume 可省略并从源运行继承；两者都先生成 canonical `subagent_session_id`，用于流式、持久化和重启恢复关联 (`packages/cli/src/tools/builtin/task/task.ts`, `packages/cli/src/agent/loop/durableToolIdentity.ts`)
- 后台活动最多每秒刷新一次 sidecar 的 `lastActiveAt`，避免每个 LoopEvent 都写盘；最终消息、统计和 worktree outcome 在终态一次性保存 (`packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
- agent 配置的 `tools` 为空或缺失表示继承全部工具，`disallowedTools` 始终优先；Claude Code 权限名会先映射到 Blade permission mode (`packages/cli/src/agent/subagents/types.ts`, `packages/cli/src/agent/subagents/SubagentRegistry.ts`)

## Recovery Semantics
- orphan reconciliation 先取得 child Session lease，再回收该 child 的前后台进程、修复 interrupted turn，并把 child JSONL 与 sidecar 已继承历史按最大首尾重叠合并 (`packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
- 后台 completion inbox ID 由 child ID 确定，父 ACK 因而可 exactly-once；同一终态重复通知不会形成不同的父输入身份 (`packages/cli/src/agent/subagents/BackgroundSubagentCompletion.ts`)
- restart recovery 无法验证 durable history 时写 `restartRecovery: failed` 并永久禁止该 run 再 resume，但不会把损坏 child 当作成功回接父会话 (`packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
