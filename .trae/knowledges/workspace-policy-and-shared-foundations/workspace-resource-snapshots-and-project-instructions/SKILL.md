---
name: knowledge-workspace-resource-snapshots-and-project-instructions
description: >
  覆盖按 source project 隔离的 Agent/模型资源、Session 不可变快照、通信风格以及静态与路径条件项目规则。
  使用时机：新增 workspace 资源来源、创建或恢复 Session、处理 Task worktree、刷新插件、注入 AGENTS/CLAUDE/BLADE 规则或校验 provenance。
  不包含：Folder Trust 决策实现见 permissions-and-workspace-trust，通用配置层级见 layered-configuration-and-runtime-settings。
  关键词：WorkspaceAgentResources, SessionAgentResources, WorkspaceModelResources, ProjectRuleCatalog, contextualRules, projectInstructionsDigest。
---

## Module Structure

该组件把进程内可刷新 workspace registry 转换为 Session 私有快照，并以 source project 为资源身份、以 execution workspace 为文件操作位置。

### Directory Layout
- `packages/cli/src/agent/resources/WorkspaceAgentResources.ts` — workspace registry 聚合、容量、刷新和 Session 快照
- `packages/cli/src/agent/resources/WorkspaceModelResources.ts` — 模型配置与 `PiModelCatalog` 的 Session 隔离
- `packages/cli/src/agent/resources/WorkspaceCommunicationStyles.ts` — 用户、项目和插件输出风格目录
- `packages/cli/src/agent/resources/WorkspaceProjectRules.ts` — 项目规则发现、优先级、路径匹配和 provenance
- `packages/cli/src/prompts/projectInstructions.ts` — 无 `ProjectRuleCatalog` 时的兼容指令加载器
- `packages/cli/src/agent/runtime/SessionRuntime.ts` — 快照创建、规则水合和 source/execution 路径映射
- `packages/cli/src/agent/loop/executeLoopGenerator.ts` — 条件规则注入与首次写入屏障

### Key Entry Points
- `resolveWorkspaceAgentResources()` — 获取或初始化指定 workspace 的可刷新资源集合
- `withWorkspaceAgentResources()` — 在 active-user pin 内执行异步管理操作
- `snapshotWorkspaceAgentResources()` — 深复制 registry、Hook、风格和规则到 Session
- `resolveWorkspaceModelResources()` — 重建目标项目的模型配置和私有 catalog
- `ProjectRuleCatalog.staticRules()` / `contextualRules()` / `hydrate()` — 静态注入、路径触发和恢复校验

## API Surface

### WorkspaceAgentResources
- `resolveWorkspaceAgentResources(workspaceRoot, options)` — 适合短时读取；返回后通过 deferred release 解除 active pin
- `withWorkspaceAgentResources(workspaceRoot, operation, options)` — 在整个异步 operation 期间保持资源不可驱逐
- `snapshotWorkspaceAgentResources(resources)` — 生成 Session-owned registry、Hook、风格和规则快照
- `resetWorkspaceAgentResources()` — 递增 generation、清空缓存并释放所有 registry 单例
- `getWorkspaceAgentResourceCacheStats()` — 暴露 resident、in-flight 和 active-user 计数

### WorkspaceModelResources
- `resolveWorkspaceModelResources(projectRoot, startupConfig)` — 返回深复制配置与 Session 私有 catalog
- `snapshotWorkspaceModelResources(resources)` — 再复制配置并以原 CredentialStore 创建新 catalog
- `cloneWorkspaceModelConfig(config)` — 深复制普通对象和数组，保留函数类运行时值

### ProjectRuleCatalog
- `list()` — 仅返回规则元数据和 digest
- `staticRules(sourceWorkspaceRoot, maxBytes?)` — 解析 Session 初始作用域内的无条件规则
- `contextualRules(sourceWorkspaceRoot, targetPaths, loadedIds, maxBytes?)` — 按工具目标路径选择尚未加载的规则
- `hydrate(references)` — 用持久化引用重建正文并验证 ID、路径、来源和 digest
- `snapshot()` — 固化定义与 pattern 数组，隔离后续磁盘和 registry 变化

## Usage Examples

### Session 创建时冻结 Agent 资源
```typescript
const resources = this.options.agentResources
  ? this.options.agentResources
  : await resolveWorkspaceAgentResources(this.projectRoot, {
      reconcilePlugins: true,
    });
this.agentResources = snapshotWorkspaceAgentResources(resources);
```

### 写入前加载路径条件规则
```typescript
const projectRules = resolveInvocationRules(toolName, params);
if (projectRules?.files.length && registry.get(toolName)?.kind === 'write') {
  return {
    success: false,
    metadata: { contextualProjectRulesRequired: true },
  };
}
```

## Gotchas
- `resolveWorkspaceAgentResources()` 只为当前调用短暂增加 users，并通过 `setImmediate` 延迟释放；管理操作跨越多个 await 且要求资源不被 LRU 驱逐时必须使用 `withWorkspaceAgentResources()` (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
- workspace registry 是可刷新对象，不能直接暴露给活动模型；只有 `snapshotWorkspaceAgentResources()` 深复制后的 registry、Hook 和目录才保证一个 Session 内工具描述与执行查找一致 (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`, `packages/cli/tests/unit/services/workspace-agent-resources.test.ts`)
- idle registry 上限为 32，初始化中或 active-user entry 的硬上限为 64；全部 entry 被 pin 时新 workspace 会在初始化前抛 `WorkspaceAgentResourceCapacityError` (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`, `git:2db1b230`)
- 初始化任一 registry 或插件集成失败时，已创建的 Subagent/Skill/Command/Plugin 单例必须全部 release；保留半初始化 generation 会污染下一次解析 (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
- `resetWorkspaceAgentResources()` 通过 generation 让迟到的初始化结果自毁；仅清空 Map 而不检查 generation 会让并发旧 Promise 重新写回已撤销资源 (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
- Task worktree 的 `workspaceRoot` 不是资源根；模型、插件、Hook、项目规则和默认配置继续来自 original source `projectRoot`，条件规则路径再从 worktree 映射回 source project (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `docs/reference/workspace-agent-resources.md`)
- 项目规则只有 Folder Trust 为 `trusted` 才发现；不可信项目返回空 catalog，而不是降级读取根 `AGENTS.md` (`packages/cli/src/agent/resources/WorkspaceProjectRules.ts`)
- 同一目录存在 AGENTS.override.md 时会完全跳过 `AGENTS.md`；它不是追加层，误把二者都注入会产生相互冲突的指令 (`packages/cli/src/agent/resources/WorkspaceProjectRules.ts`)
- 路径条件规则首次命中 Write/Edit/ApplyPatch 时会在任何副作用前返回 validation error，注入规则后要求模型下一轮重提写入；不能在当前调用中继续执行原参数 (`packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- contextual rule 正文不写入 transcript，只持久化 reference 和 digest；恢复时 `hydrate()` 发现内容、路径或来源漂移会 fail closed，避免静默改变历史 Session 的指令 (`packages/cli/src/agent/resources/WorkspaceProjectRules.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- 规则预算按从最具体、最高优先级一端反向保留完整文件，超预算文件会整体跳过而不是截断；依赖文件前半段被保留的逻辑会得到错误结果 (`packages/cli/src/agent/resources/WorkspaceProjectRules.ts`)
- Session 模型 catalog 与配置是私有副本，但 CredentialStore 有意共享；修改全局 catalog 或磁盘 endpoint 不影响活动 Session，修改同一渠道凭据仍可能影响后续请求 (`packages/cli/src/agent/resources/WorkspaceModelResources.ts`)
- 自定义通信风格对单文件、prompt、总字节、目录深度和隐藏控制字符都有独立限制；单个坏文件只记 warning 并跳过，但总目录超限会使整个解析失败 (`packages/cli/src/agent/resources/WorkspaceCommunicationStyles.ts`)

## Architecture
- 每个 canonical workspace 聚合 Subagent、Skill、Command、Plugin、CommunicationStyle 和 ProjectRule registry；插件先初始化，再把 namespaced 资源集成进同一 workspace 的各 registry (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
- Agent 资源与模型资源分开快照：前者冻结模型可见扩展，后者冻结 Provider definitions 和模型路由，两者在 SessionRuntime 创建时共同绑定 (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`, `packages/cli/src/agent/resources/WorkspaceModelResources.ts`)
- 项目规则按目录深度、同层文件优先级和路径 pattern 组成确定性目录；静态规则进入初始 system prompt，条件/深层规则在工具触达路径后增量进入下一次 Provider 请求 (`packages/cli/src/agent/resources/WorkspaceProjectRules.ts`, `packages/cli/src/prompts/builder.ts`)

## Decisions
- Session 使用不可变快照而不是实时 registry，是为了让插件启停、trust revoke 和磁盘规则变化不能改变已经暴露给模型的工具与系统提示 (`docs/reference/workspace-agent-resources.md`)
- 项目规则持久化 provenance 而不持久化正文，在保持 transcript 有界的同时强制恢复时验证历史指令语义 (`docs/reference/trusted-contextual-project-rules.md`)
- 模型 catalog 只共享安全 CredentialStore，不共享 Provider definitions，允许同一进程中相同 provider/model ID 在不同项目指向不同 endpoint (`packages/cli/src/agent/resources/WorkspaceModelResources.ts`, `packages/cli/tests/unit/services/workspace-model-resources.test.ts`)

## Consumer Analysis
- SessionRuntime 在创建和恢复时消费 Agent/Model 快照，并验证项目规则与通信风格 digest (`packages/cli/src/agent/runtime/SessionRuntime.ts`)
- 子代理与 Team Runtime 继承父快照后再次复制，保持嵌套任务资源视图稳定 (`packages/cli/src/agent/subagents/`, `packages/cli/src/agent/teams/`)
- Task、Team、Skill 和 SlashCommand 工具通过闭包绑定 Session registry，不回查全局单例 (`packages/cli/src/tools/builtin/`)
- 多项目 Session、模型、插件、Hook、Skill 和 suggestions 路由按请求目录获取精确 workspace 资源 (`packages/cli/src/server/routes/`)
- Prompt builder 与 Agent loop 分别消费静态规则和按工具路径动态加载的 contextual rules (`packages/cli/src/prompts/builder.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
