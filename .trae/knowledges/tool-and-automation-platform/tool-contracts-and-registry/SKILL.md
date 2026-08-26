---
name: knowledge-tool-contracts-and-registry
description: >
  Covers Blade 的 Tool/ToolInvocation/ToolResult 契约、createTool 工厂、TypeBox 参数边界、ToolRegistry、延迟工具发现与通用 Session 制品存储。
  Navigate when: 定义新工具字段、修改 schema 转换或校验、调整工具注册/搜索/MCP 目录、排查 metadata 或 deferred tool 可见性。
  Excludes: 实际执行阶段与重试循环（见 ../tool-execution-pipeline/）、具体领域工具行为（见相邻子节点）。
  Keywords: ToolConfig, ToolKind, ToolResult, UnifiedToolInvocation, createTool, ToolRegistry, DeferredToolManager, TypeBox, schemaToFunctionSchema, SessionArtifactStore.
---

## Module Structure

该组件是所有内置工具、MCP 工具和 Agent 表面的共享契约层。工具定义在这里被校验并
投影为 Provider function schema，注册表再决定哪些声明进入当前模型上下文。

### Directory Layout
- `packages/cli/src/tools/core/` — `createTool` 与 `UnifiedToolInvocation`
- `packages/cli/src/tools/types/` — 工具、结果、metadata、权限和执行上下文类型
- `packages/cli/src/tools/validation/` — TypeBox 校验、JSON Schema 投影和敏感文件识别
- `packages/cli/src/tools/registry/` — 内置/MCP 注册、索引、事件和延迟加载状态
- `packages/cli/src/tools/artifacts/` — 有界、私有、内容寻址的 Session 制品存储

### Key Entry Points
- `createTool()` in `packages/cli/src/tools/core/createTool.ts` — 从 `ToolConfig` 构造完整工具对象
- `ToolRegistry` in `packages/cli/src/tools/registry/ToolRegistry.ts` — 注册、筛选、克隆和投影工具目录
- `DeferredToolManager.filterDeclarations()` in `packages/cli/src/tools/registry/DeferredToolManager.ts` — 只向模型暴露已加载 schema
- `parseToolSchema()` in `packages/cli/src/tools/validation/schemaErrorFormatter.ts` — 构建 invocation 前执行 TypeBox 运行时校验
- `SessionArtifactStore` in `packages/cli/src/tools/artifacts/SessionArtifactStore.ts` — MCP 与 Browser 共用的私有制品原语

## API Surface

### `createTool`
- `createTool(config)` — 绑定 TypeBox schema、描述、权限签名、并发/重试能力和执行函数，并返回 `Tool`
- `Tool.build(params)` — 先解析默认值并拒绝无效输入，再创建不可变参数的 `ToolInvocation`
- `Tool.getFunctionDeclaration()` — 将内部 schema 和多段描述转换为 Provider function declaration
- `Tool.getMetadata()` — 暴露工具目录元数据，包括显式归一化后的 `isRetrySafe` 与 `parallelism`

### `ToolRegistry`
- `register()` / `registerAll()` — 注册内置工具并同步分类、标签和 deferred 状态
- `replaceMcpTools()` — 原子替换动态 MCP 目录并保留内置名称冲突保护
- `getFunctionDeclarationsByMode()` — 组合 Plan 模式过滤与 deferred schema 过滤
- `clone()` — 共享工具对象但重新建立注册表、索引与 deferred 状态
- `drainMcp*()` — 以有界队列向 Agent loop 交付 MCP 目录、内容、连接、日志和任务变化

### `DeferredToolManager`
- `register()` / `syncDynamicTools()` — 维护立即加载与延迟加载集合
- `markLoaded()` — 在 `ToolSearch` 成功后把完整 schema 纳入后续 Provider 请求
- `getDeferredToolsListing()` — 生成按名称排序的 `<available-deferred-tools>` 提示片段

### `SessionArtifactStore`
- `write()` — 校验单件/Session 配额，以 SHA-256 为 ID 写入 `0600` 文件并去重
- `removeAll()` — 删除一个 Session namespace 并重置内存计数

## Usage Examples

### 定义一个可安全重放的查询工具
```typescript
const tool = createTool({
  name: 'Read',
  kind: ToolKind.ReadOnly,
  isConcurrencySafe: true,
  isRetrySafe: true,
  schema: Type.Object({ file_path: ToolSchemas.filePath() }),
  execute: async (params, context) => read(params, context),
});
```

### 注册 Session 工具并投影动态 MCP 目录
```typescript
this.baseRegistry.registerAll(builtin);
this.baseRegistry.replaceMcpTools(registry.getCatalogSnapshot().tools);
this.baseRegistry.registerAll(createMcpContentTools(registry));
this.baseRegistry.registerAll(createMcpTaskTools(registry));
```

## Gotchas
- `ToolKind.ReadOnly` 不表示语义幂等；`CreateGoal`、`TaskCreate` 等会改变持久状态但仍为 Plan 可用的 ReadOnly，重试资格必须单独显式声明 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/builtin/goal/goalTools.ts`, `packages/cli/src/tools/builtin/task/taskListTools.ts`)
- `isConcurrencySafe` 默认 `false`，`parallelism` 默认随它选择 shared/exclusive；显式 `parallelism: 'shared'` 可允许不同调用进入批内共享门，但 `isConcurrencySafe: false` 仍会启用同路径文件锁和禁止流式预启动 (`packages/cli/src/tools/core/createTool.ts`, `packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/agent/loop/StreamingToolExecutor.ts`)
- `isRetrySafe` 在 config、tool、metadata 和 invocation 四处传播且默认 `false`；新增工具若漏写不会自动重放，这是有意的 fail-closed 契约 (`packages/cli/src/tools/core/createTool.ts`, `packages/cli/src/tools/core/ToolInvocation.ts`, `packages/cli/src/tools/types/ToolTypes.ts`)
- `Tool.build()` 已经执行 TypeBox 校验与默认值注入，Hook 修改参数后必须重新 `build`，不能继续执行旧 invocation (`packages/cli/src/tools/core/createTool.ts`, `packages/cli/src/tools/execution/ToolExecutionHooks.ts`)
- `ToolRegistry.registerAll()` 逐个注册后才聚合错误，不提供批次回滚；调用方不应把失败批量注册视为零副作用 (`packages/cli/src/tools/registry/ToolRegistry.ts`)
- 内置工具名优先于 MCP 工具名；动态 MCP 替换遇到内置冲突或批内重名会直接失败，而同名已有 MCP 工具可被新目录覆盖 (`packages/cli/src/tools/registry/ToolRegistry.ts`)
- `clone()` 共享 `Tool` 实例，但 deferred 加载集合和待排出的 MCP 事件不是原对象的副本；每个执行器目录需独立经历 ToolSearch 与变化投影 (`packages/cli/src/tools/registry/ToolRegistry.ts`)
- TypeBox 转 Provider JSON Schema 时会递归移除 `~` 运行时注解，并为对象补 `required: []` 与 `additionalProperties: false`；直接序列化 TypeBox schema 会产生不同契约 (`packages/cli/src/tools/validation/schemaToJson.ts`)
- `SessionArtifactStore` 发现已有同 hash 文件时会重新校验 owner、`0600`、大小和内容哈希，权限漂移不会被当作正常去重命中 (`packages/cli/src/tools/artifacts/SessionArtifactStore.ts`)

## Architecture
- 工具对象同时服务三类消费者：Provider 获取 function declaration，执行器构建 invocation，UI/Server 读取统一结果与 metadata；这些字段变化通常需要跨层同步 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/core/createTool.ts`)
- 注册表将内置与 MCP 工具保存在独立 Map 中，却共享分类/标签索引和 deferred 管理器，因此动态目录替换必须先移除旧索引再加入新索引 (`packages/cli/src/tools/registry/ToolRegistry.ts`)
- deferred 机制只延迟 schema 暴露，不延迟工具实例注册；`ToolSearch` 从完整 registry 搜索后标记当前 manager，下一轮 Provider 请求才会看到声明 (`packages/cli/src/tools/registry/DeferredToolManager.ts`, `packages/cli/src/tools/builtin/system/ToolSearchTool.ts`)
- MCP 变化通知使用小型有界内存队列，目录/内容/连接默认最多 32 条、日志和任务最多 64 条；drain 是 destructive read (`packages/cli/src/tools/registry/ToolRegistry.ts`)

## Decisions
- `isReadOnly` 字段已被移除，权限只从 `ToolKind` 推断；新增代码不应恢复第二套只读真相源 (`packages/cli/src/tools/types/ToolTypes.ts`, `git:a074815b`)
- 工具 schema 从 Zod 迁移到 TypeBox，是为了让运行时校验与 Provider JSON Schema 来自同一声明 (`packages/cli/src/tools/core/createTool.ts`, `packages/cli/src/tools/validation/schemaToJson.ts`, `git:311ba368`)
- MCP 与 Browser 的二进制结果复用 `SessionArtifactStore`，但通过 namespace、Session identity、配额与是否暴露路径保持隔离 (`packages/cli/src/tools/artifacts/SessionArtifactStore.ts`, `packages/cli/src/browser/BrowserArtifactStore.ts`)

## Patterns
- `affectedPaths` 用于安全审阅、worktree 边界和多文件权限匹配；多路径工具应返回完整目标集合，而不是只依赖 `file_path` 惯例 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/builtin/file/applyPatch.ts`)
- 权限签名优先使用 `extractSignatureContent`，项目级规则再通过 `abstractPermissionRule` 泛化；两者缺失会降低审批可读性并阻止持久化项目规则 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/execution/ToolApprovalController.ts`)
- 统一结果允许领域 metadata 扩展，但 `llmContent` 与 metadata 职责不同：前者供模型消费，后者供持久化和表面投影 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/display/ToolResultProjector.ts`)

## Consumer Analysis
- `packages/cli/src/tools/builtin/` 是 `createTool` 和 `ToolConfig` 的最大消费者；所有内置能力都通过同一工厂获得校验、metadata 与 invocation 行为 (`packages/cli/src/tools/builtin/index.ts`)
- `packages/cli/src/agent/runtime/SessionRuntime.ts` 构造基础注册表和每个 Agent 的过滤注册表，并把 Browser、LSP、Skill、Task 等 Session 私有对象注入工具工厂 (`packages/cli/src/agent/runtime/SessionRuntime.ts`)
- `packages/cli/src/agent/loop/` 消费 function declarations、deferred listing、`ExecutionContext` 和 `ToolResult`，并把 registry/manager 放入每次调用上下文供 `ToolSearch` 使用 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/agent/loop/providerSystemPrompt.ts`)
- `packages/cli/src/mcp/` 将外部 MCP schema 包装为 `ToolKind.Execute` 的 Blade 工具，并通过动态目录替换而非内置注册路径更新 (`packages/cli/src/mcp/createMcpTool.ts`, `packages/cli/src/mcp/McpRegistry.ts`)
- `packages/cli/src/browser/` 与 `packages/cli/src/mcp/` 共同消费 `SessionArtifactStore`；Browser 隐藏 ACP 路径，MCP 使用独立 namespace 和类型约束 (`packages/cli/src/browser/BrowserArtifactStore.ts`, `packages/cli/src/mcp/McpToolArtifactStore.ts`)
