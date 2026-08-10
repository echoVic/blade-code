# Workspace Agent Resource Isolation

Blade 按 source project 管理 subagents、skills、custom commands、plugins、
communication styles 和 contextual project rules。进程当前
目录与 Store 只用于启动表面，不能作为并行 Web、ACP、TUI 或 Task Session 的资源
查找来源。

## 两层资源模型

每个 canonical project path 对应一组可刷新 workspace registry：

- `SubagentRegistry`
- `SkillRegistry`
- `CustomCommandRegistry`
- `PluginRegistry`
- `CommunicationStyleCatalog`
- `ProjectRuleCatalog`

`resolveWorkspaceAgentResources(projectRoot)` 负责一次性加载用户级资源、通过
Workspace Trust 的项目资源、显式 `--plugin-dir`，再把 plugin commands、skills 和
agents 集成到同一 project 的 registry。不同 project 不共享可变 registry。

创建 `SessionRuntime` 时，Blade 会复制出 Session 私有快照：

- subagent 配置及工具/skill 列表深复制；
- skill metadata 与 plugin skill 映射复制；
- custom/plugin command 配置复制；
- 有效 plugin Hook 配置复制并按 Session 身份绑定；
- custom output style prompt 与 project rule catalog 深复制；
- Task、Team、Skill、SlashCommand 工具通过闭包绑定该快照。

项目刷新、plugin enable/disable、trust revoke 或 UI 管理操作只更新 workspace
registry，不会改变已经暴露给活动模型回合的工具描述与执行查找结果。

## 来源与优先级

workspace registry 按现有兼容优先级加载：

1. 内置资源
2. Claude Code 用户级资源
3. Blade 用户级资源
4. 已信任项目的 Claude Code 兼容资源
5. 已信任项目的 Blade 资源
6. user/project/CLI plugins 的 namespaced resources
7. 当前 invocation 的 `--agents` 覆盖

`--agents` 只写入 Session 快照，不修改 workspace 基础表。`--plugin-dir` 在 CLI
模式分流前解析，因此 TUI、print、headless、serve 和 ACP 使用相同显式 plugin 来源。

未信任项目只能使用内置、用户级和显式 CLI 来源。项目 plugins、commands、skills
和 agents 均 fail closed。

## 子 Session 与 worktree

Task 与 Team 创建前台、后台或 resume 子 Session 时，会显式传递父 Session 的资源
快照。子 Session 再复制一次，因此：

- invocation agent 能继续用于嵌套 Task；
- plugin 刷新不会改变正在运行的 child；
- resume 保留父 Session 创建时的资源视图；
- project A 的资源不能进入 project B 的 child。

`projectRoot` 表示资源与配置身份，`workspaceRoot` 表示文件执行路径。Task worktree
只替换 `workspaceRoot`；资源、plugin MCP、hooks、project rules 和默认配置仍以
source project 解析。contextual rule trigger path 会从 execution workspace 映射回
source project 后匹配。

## 表面一致性

- CLI/TUI：`useAgent` 把 invocation agents 传给 `SessionRuntime`，管理面操作精确
  当前 workspace registry。
- Web：每个 `sessionId + projectPath` Runtime 持有独立快照，多项目任务可并发运行；
  Folder Trust 更新会重建 workspace registry。
- ACP：每个 `session/new` 的 `cwd` 独立解析资源；同一 ACP 连接中的不同 cwd Session
  不共享 project resources。

## 资格验证

确定性测试使用两个真实临时目录加载原生与 plugin agents/skills/commands，随后清空
workspace registry，证明 Session 工具仍保持原快照且对方资源零命中。

真实 API 资格包括：

- GPT 双 `SessionRuntime` 并发调用各自 plugin command；
- GPT 在同一 ACP connection 的双 cwd Session 中分别调用各自 plugin command；
- DeepSeek Flash/Pro 通过生产 CLI `--agents -> Task` 完成 Read/Edit/Bash；
- production Web GUI 绑定并信任 A/B 两项目，在独立 worktree 中分别调用
  `plugin-a:reveal` 与 `plugin-b:reveal`，回切后投影保持独立，fresh tab 无 console
  error。

## 相关资源

- [Workspace Trust](../guides/workspace-trust.md)
- [MCP Session 隔离](mcp-session-isolation.md)
- [工具并发模型](tool-concurrency.md)
- [Trusted Contextual Project Rules](trusted-contextual-project-rules.md)
- [测试与生产准出](../testing/qualification.md)
