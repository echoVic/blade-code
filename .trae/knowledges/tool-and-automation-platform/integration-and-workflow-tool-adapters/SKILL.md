---
name: knowledge-integration-and-workflow-tool-adapters
description: >
  Covers 领域能力如何包装成内置工具、getBuiltinTools 的 Session 依赖注入、ToolSearch 延迟激活，以及 Goal/Task/Team/Plan/Skill/LSP/MCP/Web/Config/Worktree 适配边界。
  Navigate when: 新增或移除内置工具、改变工具集合条件、调整领域工厂依赖、排查 deferred schema、MCP helper 或工作流工具权限分类。
  Excludes: 各领域内部状态机（见对应顶层域）、通用 Tool 契约（见 ../tool-contracts-and-registry/）、执行顺序（见 ../tool-execution-pipeline/）。
  Keywords: getBuiltinTools, ToolSearch, createGoalTools, createTaskTools, createTeamTools, createMcpContentTools, createMcpTaskTools, createLspTool, createBrowserTools.
---

## Module Structure

该组件不实现领域核心状态，而是把 Session 拥有的服务、注册表和资源快照适配为统一
`Tool[]`。静态单例工具与依赖注入工厂在 `getBuiltinTools` 汇合，再由 SessionRuntime
加入动态 MCP 工具和按 Agent 的 allow/deny 过滤。

### Directory Layout
- `packages/cli/src/tools/builtin/index.ts` — 内置工具组合根与条件注入
- `packages/cli/src/tools/builtin/system/` — ToolSearch、Skill、SlashCommand、AskUserQuestion 与 prompt artifact
- `packages/cli/src/tools/builtin/task/` / `team/` / `goal/` — Agent 工作流适配器
- `packages/cli/src/tools/builtin/mcp/` / `lsp/` — MCP 内容/任务与 Session LSP 查询适配器
- `packages/cli/src/tools/builtin/web/` — WebFetch/WebSearch、缓存和 Provider fallback
- `packages/cli/src/tools/builtin/config/` / `memory/` / `plan/` / `worktree/` — 配置、记忆、模式和工作区适配器

### Key Entry Points
- `getBuiltinTools()` in `packages/cli/src/tools/builtin/index.ts` — 依据 Session 能力构造完整内置目录
- `toolSearchTool` in `packages/cli/src/tools/builtin/system/ToolSearchTool.ts` — 搜索并激活 deferred schema
- `createMcpTool()` in `packages/cli/src/mcp/createMcpTool.ts` — 将外部 MCP tool definition 转换为 Blade Tool
- `SessionRuntime.registerBuiltinTools()` in `packages/cli/src/agent/runtime/SessionRuntime.ts` — 注入 Session-owned Browser/LSP/资源

## API Surface

### `getBuiltinTools`
- `getBuiltinTools(options?)` — 返回当前 Session 的工具数组，并为需要状态的领域调用工厂
- `browserRuntime` — 提供时加入六个 Browser 工具，否则不暴露 Browser 能力
- `lspManager` / `lspResources` — 仅 manager available 时加入 LSP，并传给子代理
- `agentTeamsEnabled` — 唯一控制 Team 工具是否进入目录的显式能力门
- `agentResources` / `modelResources` — 固定当前 Session 的 Agent、Skill、命令与模型资源
- `userPromptArtifactStore` — 提供时加入 `ReadPromptArtifact`

### Domain Adapter Factories
- `createGoalTools()` / `createTaskListTools()` / `createTeamTools()` — 把持久状态和协调服务包装为工具
- `createSkillTool()` / `createSlashCommandTool()` — 加载 Markdown 扩展并把约束返回给主对话
- `createLspTool()` / `createBrowserTools()` — 绑定 Session-owned runtime，避免模块级跨会话状态
- `createMcpContentTools()` / `createMcpTaskTools()` — 暴露当前 MCP catalog 与异步任务，而外部 MCP 方法由 `createMcpTool()` 动态生成

### `ToolSearch`
- `select:<name,...>` — 按精确名称返回 function declarations 并标记已加载
- 普通 query — 搜索名称、显示名、描述、分类和标签，并受 `max_results` 限制

## Usage Examples

### Session 注入可用能力
```typescript
const builtinTools = await getBuiltinTools({
  sessionId: this.sessionId,
  workspaceRoot: this.workspaceRoot,
  agentResources: this.agentResources,
  lspManager: this.lspManager,
  browserRuntime: this.browserRuntime,
});
```

### 在基础目录上叠加 MCP 能力
```typescript
this.baseRegistry.replaceMcpTools(registry.getCatalogSnapshot().tools);
this.baseRegistry.registerAll(createMcpContentTools(registry));
this.baseRegistry.registerAll(createMcpTaskTools(registry));
```

## Gotchas
- `getBuiltinTools()` 混合模块级单例和 Session 工厂；任何持有 Session 状态的新工具必须通过 options 注入，不能在模块加载时捕获当前 cwd、Session 或 runtime (`packages/cli/src/tools/builtin/index.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- 当前 fail-closed 重试清单只有 `GetGoal`、`Glob`、`Grep`、`LSP`、`MemoryRead`、`Read`、`ReadPromptArtifact`、`TaskGet`、`TaskList`、`TeamStatus`、`ToolSearch`；未列出的工具即使是 ReadOnly 也不会自动重放 (`packages/cli/tests/unit/tooling/tools/builtin/tool-retry-safety.test.ts`, `packages/cli/src/tools/core/createTool.ts`)
- `ToolKind.ReadOnly` 是权限标签而非“没有状态变化”：`CreateGoal`、`UpdateGoal`、`TaskCreate/Update` 和多项 Team 工具会写持久状态但为 Plan 流程保留 ReadOnly 分类，因此仍显式关闭并发和重试 (`packages/cli/src/tools/builtin/goal/goalTools.ts`, `packages/cli/src/tools/builtin/task/taskListTools.ts`, `packages/cli/src/tools/builtin/team/teamTools.ts`)
- `WebFetch` 被声明为 ReadOnly，但 schema 允许 POST/PUT/DELETE 和 body；它没有 `isRetrySafe`，修改权限或重试策略时不能只依据 kind 把任意请求视为无副作用 (`packages/cli/src/tools/builtin/web/webFetch.ts`)
- `WebSearch` 没有工具级 `isRetrySafe`，但其内部 HTTP provider 会做最多 3 次指数退避并在多个 Provider 间 failover；不要再叠加 invocation 重放造成成倍请求 (`packages/cli/src/tools/builtin/web/webSearch.ts`)
- MCP catalog 中的外部工具统一包装为 `ToolKind.Execute` 且默认不可重放，即使远端 schema/描述声称只读也不会改变本地权限基线 (`packages/cli/src/mcp/createMcpTool.ts`)
- MCP 内容和任务 helper 是内置工具，不属于动态 `mcp__*` Map；替换 MCP catalog 时不能删除这些 helper，SessionRuntime 会分别注册两类工具 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/tools/builtin/mcp/mcpContentTools.ts`)
- `ToolSearch` 只在 `ExecutionContext` 同时拿到 registry 和 deferred manager 时永久激活当前目录中的 schema；返回 `<functions>` 文本本身不会修改其他 executor 的加载状态 (`packages/cli/src/tools/builtin/system/ToolSearchTool.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- Browser、LSP、Teams 和 prompt artifact 都是条件工具；测试或备用 Agent 用缺省 options 调 `getBuiltinTools()` 时看到的目录必然更小 (`packages/cli/src/tools/builtin/index.ts`, `packages/cli/src/agent/Agent.ts`)
- Skill 和 SlashCommand 返回的是供后续模型执行的指令及 `allowedTools`/model 元数据，不会在工具函数内部直接完成整个 Skill 或命令请求 (`packages/cli/src/tools/builtin/system/skill.ts`, `packages/cli/src/tools/builtin/system/slashCommand.ts`)
- `TaskOutput` 聚合子代理、MCP task 和 Background Shell 三类 ID；新增后台任务类型时必须同步路由和结果形状，不能只在 producer 侧注册 (`packages/cli/src/tools/builtin/task/taskOutput.ts`)

## Architecture
- 内置目录先由 `getBuiltinTools` 组装，SessionRuntime 再过滤非 `mcp__` 内置项、接入 MCP catalog 与 helper，最后为每个 Agent 创建独立过滤 registry (`packages/cli/src/tools/builtin/index.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- 工厂注入将状态所有权留在领域服务：GoalStore、TaskListManager、LspSessionManager、SessionBrowserRuntime、SkillRegistry 等不会被通用 Tool 接口重新实现 (`packages/cli/src/tools/builtin/goal/goalTools.ts`, `packages/cli/src/tools/builtin/lsp/lsp.ts`, `packages/cli/src/tools/builtin/browser/browserTools.ts`)
- deferred 工具仍已注册并可被 `ToolSearch` 搜索，只是 full schema 不进入 Provider 请求；核心工具集合由 `DeferredToolManager` 的固定 allowlist 立即暴露 (`packages/cli/src/tools/registry/DeferredToolManager.ts`, `packages/cli/src/tools/builtin/system/ToolSearchTool.ts`)
- 动态 MCP catalog 变化会同步到所有已创建 executor registry，并按各自 allow/deny 集重新过滤，避免旧 Agent 看到已删除或越权工具 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/tools/registry/ToolRegistry.ts`)

## Decisions
- Browser 只有在 SessionRuntime 创建并注入 runtime 后加入目录，保持 import/启动无 Chromium 副作用且确保 Session dispose 能回收 Context (`packages/cli/src/tools/builtin/index.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- LSP 只有 Session manager 报告 available 时才注册，且 ACP-owned remote files 不走本地 LSP，避免暴露一个必然失败的 schema (`packages/cli/src/tools/builtin/lsp/lsp.ts`, `packages/cli/src/tools/builtin/index.ts`)
- deferred catalog 用 ToolSearch 实现渐进披露，核心编辑/搜索/任务工具常驻，Browser 与多数集成能力仅以名称进入系统提示，降低每轮 schema token 成本 (`packages/cli/src/tools/registry/DeferredToolManager.ts`, `git:25d5a7d3`)

## Patterns
- 单例无状态工具直接导入，依赖 Session 状态的工具统一使用 `createXTools(options)`；新增适配器应先判断它属于哪一类 (`packages/cli/src/tools/builtin/index.ts`)
- 适配器失败应返回统一 `ToolResult` 和稳定 error type/code，把领域对象限制在 metadata，而不是把原始异常或内部路径直接泄露给模型 (`packages/cli/src/tools/builtin/browser/browserTools.ts`, `packages/cli/src/mcp/createMcpTool.ts`)
- 读取类领域工具只有经过幂等审计后才添加 `isRetrySafe: true`；“查询”名称、ReadOnly kind 或 `isConcurrencySafe` 都不足以作为 opt-in 理由 (`packages/cli/src/tools/builtin/lsp/lsp.ts`, `packages/cli/src/tools/builtin/system/readPromptArtifact.ts`)

## Consumer Analysis
- `packages/cli/src/agent/runtime/SessionRuntime.ts` 是完整消费者：它注入 Session 资源、注册 MCP helper、传播 catalog 变化，并为前台 Agent、子代理和旁路对话创建过滤 executor (`packages/cli/src/agent/runtime/SessionRuntime.ts`)
- `packages/cli/src/agent/Agent.ts` 是兼容/独立消费者：缺少完整 Session runtime 时用默认资源构建较小目录，并单独连接 MCP 内容工具 (`packages/cli/src/agent/Agent.ts`)
- `packages/cli/src/agent/loop/executeLoopGenerator.ts` 消费模式过滤后的 declarations 与 deferred listing，并把 registry/manager 回注到调用上下文以支持 ToolSearch (`packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- `packages/cli/src/mcp/` 同时生产动态外部 Tool 和供 builtin 工厂使用的 Registry；外部调用、内容目录和异步 task 的所有权不能在适配层混为一类 (`packages/cli/src/mcp/createMcpTool.ts`, `packages/cli/src/mcp/McpRegistry.ts`)
- `packages/cli/src/ui/`、`packages/cli/src/commands/headless.ts`、`packages/cli/src/server/` 和 `packages/cli/src/acp/` 不直接实现领域工具，而是消费统一 ToolResult、确认请求和展示投影 (`packages/cli/src/tools/display/ToolResultProjector.ts`, `packages/cli/src/ui/utils/toolFormatters.ts`)
