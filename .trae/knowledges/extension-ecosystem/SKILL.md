---
name: knowledge-extension-ecosystem
description: >
  覆盖 Blade 的 MCP、插件、Skills、自定义命令、Hooks 与 LSP 扩展边界及其 Session
  集成关系。进入条件：新增扩展来源、调整 Workspace 扩展发现、排查插件资源未生效、
  修改扩展资源快照或判断扩展职责归属。不包含：内置工具执行管线（见
  ../tool-and-automation-platform/）、Workspace Trust 与通用配置合并（见
  ../workspace-policy-and-shared-foundations/）。关键词：extension ecosystem、
  MCP、plugin、SkillRegistry、CustomCommandRegistry、HookManager、LspSessionManager。
---

## Module Structure

扩展生态先在 source project 上发现配置与资源，再由 Workspace 级注册表完成插件整合，
最后冻结为 Session 私有视图；MCP 和 LSP 还会在 Session 初始化时创建独立连接与进程。

### Directory Layout
- `packages/cli/src/mcp/` — MCP transport、目录、交互、恢复、OAuth 与异步任务
- `packages/cli/src/plugins/` — 插件发现、装载及向其他扩展点的资源注入
- `packages/cli/src/skills/` — Skill 元数据发现、正文延迟加载与注册表
- `packages/cli/src/slash-commands/custom/` — Markdown 自定义命令解析和执行
- `packages/cli/src/hooks/` — Hook 配置、匹配、信任与多种执行后端
- `packages/cli/src/lsp/` — Session 级语言服务器客户端和语义查询
- `.blade/` — 仓库内项目级 Skills、命令与配置资源

### Key Entry Points
- `resolveWorkspaceAgentResources()` in `packages/cli/src/agent/resources/WorkspaceAgentResources.ts` — 初始化并缓存 Workspace 扩展注册表
- `snapshotWorkspaceAgentResources()` in `packages/cli/src/agent/resources/WorkspaceAgentResources.ts` — 创建 Session 持有的扩展资源快照
- `resolveWorkspaceMcpConfig()` in `packages/cli/src/mcp/resolveWorkspaceMcpConfig.ts` — 合并当前 Session 的 MCP 来源
- `resolveWorkspaceLspResources()` in `packages/cli/src/lsp/WorkspaceLspResources.ts` — 解析并冻结当前 Session 的 LSP 配置
- `SessionRuntime.initialize()` in `packages/cli/src/agent/runtime/SessionRuntime.ts` — 绑定 Hooks 并创建 Session 私有 MCP/LSP 运行时

## Gotchas
- Workspace Trust 只决定项目扩展资源能否被发现，配置型 Hook 还必须通过独立的精确摘要信任；信任 workspace 不等于信任其中的命令、Prompt 或 HTTP Hook(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/hooks/HookTrustService.ts`)
- source project 是 MCP/LSP/插件配置身份，execution workspace 是 worktree 中实际执行工具和启动 LSP 的路径；将两者混用会让 MCP 默认 cwd、MCP roots 或 LSP 文件边界指向错误 checkout(`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/mcp/resolveWorkspaceMcpConfig.ts`, `packages/cli/src/lsp/LspSessionManager.ts`)
- 插件刷新先清空再整批重注入 Workspace 注册表，但已创建 Session 使用 Skills、命令、Hooks 和 LSP 的快照，不应被刷新中的可变对象追改(`packages/cli/src/plugins/PluginIntegrator.ts`, `packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
- 插件整合阶段只登记 MCP/LSP 定义数量，不建立连接；实际 MCP client 和 LSP process 都延迟到精确 Session 中创建(`packages/cli/src/plugins/PluginIntegrator.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- MCP、LSP、Skills 和命令均按 workspace 或 Session 隔离，不能以无参数全局单例作为多项目调用的权威来源(`packages/cli/src/mcp/McpRegistry.ts`, `packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts`)

## Architecture
- 扩展资源主链路是“Workspace 发现与插件整合 → Session 快照 → 工具/Prompt/事件适配”；该边界让项目切换和插件刷新不改变正在运行的模型回合(`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- 插件是扩展聚合入口，可同时提供命令、Skills、Agents、Hooks、MCP 和 LSP；其中命令、Skills、Agents 注入 Workspace 注册表，Hooks 整批交换配置，MCP/LSP 由 Session 重新解析(`packages/cli/src/plugins/PluginIntegrator.ts`, `packages/cli/src/plugins/PluginLoader.ts`)
- Skills 与自定义命令都以 Markdown 为载体，但 Skills 将元数据暴露给模型并延迟加载正文，自定义命令会在发现时加载正文并在调用前展开参数、Shell 和文件引用(`packages/cli/src/skills/SkillLoader.ts`, `packages/cli/src/slash-commands/custom/CustomCommandExecutor.ts`)
- Hooks 是扩展域的行为拦截层，横跨工具准入、权限、会话、Agent 停止、压缩和 MCP Elicitation；它不拥有这些领域的主状态(`packages/cli/src/hooks/types/HookTypes.ts`, `packages/cli/src/tools/execution/ToolExecutionHooks.ts`)
- MCP 工具和 LSP 工具都进入统一 ToolRegistry，但前者是外部 Execute 工具与动态目录，后者是仅在 Session 有可用服务器时注册的 ReadOnly 语义查询工具(`packages/cli/src/mcp/createMcpTool.ts`, `packages/cli/src/tools/builtin/index.ts`)

## Decisions
- 运行时资源在 Session 创建时做深拷贝快照，是为了阻止后续 workspace refresh、项目切换或插件刷新改变活动 Session 已暴露给模型的能力集合(`packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts`, `git:f6a82242`)
- 扩展点统一经过 Workspace Trust 后再读取项目级可执行资源，同时保留用户级资源可用性；Hooks 额外按内容摘要授权，避免“信任路径”永久授权后续修改(`packages/cli/src/security/WorkspaceTrustService.ts`, `packages/cli/src/hooks/HookTrustService.ts`, `git:a172a7c0`)
- MCP 与 LSP 放在独立 Session 生命周期而非进程全局生命周期，以隔离并行 Session 的连接、目录、诊断、环境和清理责任(`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/mcp/McpRegistry.ts`, `packages/cli/src/lsp/LspSessionManager.ts`)

## Patterns
- 插件资源使用 `plugin:<plugin-name>:<resource>` 或稳定 provider 名称避免跨插件冲突；短名只在唯一时才可解析(`packages/cli/src/plugins/namespacing.ts`, `packages/cli/src/skills/SkillRegistry.ts`, `packages/cli/src/slash-commands/custom/CustomCommandRegistry.ts`)
- 外部扩展产生的 schema、日志、结果、指令和配置都在进入模型或 UI 前做大小、类型和安全投影，不能直接透传协议对象(`packages/cli/src/mcp/McpToolResult.ts`, `packages/cli/src/hooks/schemas/HookSchemas.ts`, `packages/cli/src/config/lspSettings.ts`)

## Child Knowledge Nodes
- `./mcp-protocol-runtime/SKILL.md` — 进入条件：修改 MCP transport、动态目录、OAuth、Elicitation、Sampling、Tasks、结果安全或连接恢复
- `./plugin-lifecycle-and-marketplace/SKILL.md` — 进入条件：修改插件发现、安装、来源策略、兼容性、命名空间或资源注入
- `./skills-and-custom-commands/SKILL.md` — 进入条件：修改 SKILL.md/命令 Markdown 解析、覆盖优先级、延迟加载、Session 快照或调用入口
- `./hooks-and-behavior-interception/SKILL.md` — 进入条件：修改 Hook 事件、匹配、执行顺序、信任摘要、错误策略或跨领域拦截行为
- `./lsp-code-intelligence/SKILL.md` — 进入条件：修改 LSP 配置、进程代际、文档同步、诊断回注、语义查询或子 Session 继承
