---
name: knowledge-layered-configuration-and-runtime-settings
description: >
  覆盖 Blade 的用户/项目/local/调用级配置合并、workspace 定向解析、运行时 Store 投影和字段持久化路由。
  使用时机：新增配置字段、调整覆盖优先级、排查多项目配置串扰、修改模型/Provider/MCP/LSP/插件设置或 Web 设置保存。
  不包含：权限决策与 Folder Trust 细节见 permissions-and-workspace-trust，Session 资源冻结见 workspace-resource-snapshots-and-project-instructions。
  关键词：ConfigManager, ConfigService, FIELD_ROUTING_TABLE, RuntimeConfig, configActions, settings.local.json, BLADE_MODEL。
---

## Module Structure

配置系统将启动读盘、内存投影和磁盘持久化拆成三个边界，并为非启动 workspace 提供按 source project 重建执行配置的专用入口。

### Directory Layout
- `packages/cli/src/config/ConfigManager.ts` — 多层读取、信任过滤、归一化、验证和 workspace 定向解析
- `packages/cli/src/config/ConfigService.ts` — 字段/作用域路由、防抖、原子写和并发协调
- `packages/cli/src/config/defaults.ts` — 完整默认配置与默认权限
- `packages/cli/src/config/types.ts` — `BladeConfig`、`RuntimeConfig` 和 Provider/权限类型
- `packages/cli/src/config/runtimeEnvironment.ts` — Session 环境变量名称和值校验
- `packages/cli/src/store/slices/configSlice.ts` — 启动进程内存配置投影
- `packages/cli/src/store/vanilla.ts` — 面向 TUI、Server 和命令的配置动作
- `packages/cli/src/server/routes/config.ts` — Web 公开配置投影与更新 API
- `packages/cli/web/src/store/ConfigStore.ts` — workspace 模型选择与权限模式状态
- `packages/cli/web/src/store/SettingsStore.ts` — 通用设置的乐观更新与失败回滚

### Key Entry Points
- `ConfigManager.initialize()` — 合并默认、用户、可信项目、local 和调用级设置
- `ConfigManager.loadWorkspaceModelConfig()` — 为目标 source project 重建模型与 Provider 配置
- `ConfigManager.loadWorkspaceRuntimeSettings()` — 为目标 source project 解析 env、Hook 开关、轮次和权限模式
- `ConfigService.save()` — 按字段元数据选择文件、scope 和合并策略
- `configActions().updateConfig()` — 先更新 Store，再持久化，失败时回滚内存

## API Surface

### ConfigManager
- `initialize(additionalSettings?)` — 生成启动进程的完整 `RuntimeConfig`
- `reload()` — 使用上次显式运行时覆盖重新读取配置
- `loadWorkspacePermissions(workspaceRoot, base)` — 去除启动项目私有规则并叠加目标 workspace 规则
- `loadWorkspaceModelConfig(workspaceRoot, base)` — 重建目标 workspace 的模型、Provider 与准入配置
- `loadWorkspaceRuntimeSettings(workspaceRoot, base)` — 重建目标 workspace 的执行环境和行为设置
- `loadWorkspaceMcpServers()` / `loadWorkspaceLspServers()` — 按目标 workspace 隔离可执行服务配置

### ConfigService
- `save(updates, options)` — 校验可持久化字段并路由到目标文件
- `flush()` — 立即提交所有防抖写入
- `appendLocalPermissionRule()` / `appendLocalPermissionDenyRule()` — 对目标 workspace 做原子追加去重
- `removePluginSetting()` — 从指定 scope 删除插件覆盖而非写入相反值

### Store Actions
- `configActions().updateConfig()` — 内存先行并在持久化失败时恢复快照
- `configActions().setPermissionMode()` — 仅更新本次运行状态
- `configActions().addModelWithProvider()` — 原子更新 catalog、模型和 Provider 配置

## Usage Examples

### 为 Session 重建目标 workspace 配置
```typescript
const modelResources = await resolveWorkspaceModelResources(hookConfigRoot, config);
const runtimeConfig: BladeConfig = {
  ...modelResources.config,
  permissions: await configManager.loadWorkspacePermissions(
    hookConfigRoot,
    modelResources.config.permissions
  ),
};
```

### 通过共享动作持久化 Web 配置
```typescript
const { updates, options } = parsed.data;
await configActions().updateConfig(updates, options);
```

## Gotchas
- `ConfigManager.initialize()` 捕获任意加载或验证错误后会重置全局模型目录并返回 `DEFAULT_CONFIG`；调用方看到的可能是“没有模型”而不是原始坏配置，诊断时必须检查启动日志 (`packages/cli/src/config/ConfigManager.ts`)
- 进程 Store 不是多 workspace 执行配置的权威来源；目标目录与启动 cwd 不同时，模型、MCP、LSP、权限和运行时设置必须分别从用户层与该目标项目重建 (`packages/cli/src/config/ConfigManager.ts`, `git:3549bb1e`)
- 跨 workspace 权限解析会先从传入 base 中剔除启动项目独有规则，再叠加目标项目规则；直接在 base 上追加会把服务器启动目录的本地授权泄漏给其他 Session (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/tests/integration/config.test.ts`, `git:7b34bd7e`)
- `config.json` 与 `settings.json` 不共享统一的深合并语义：模型数组整体替换，Provider/MCP/LSP 和插件映射按键合并，permissions 数组追加去重，Hook/env 深合并 (`packages/cli/src/config/ConfigManager.ts`)
- `permissionMode` 可以从启动参数或可信 settings 进入运行时，但 `ConfigService` 明确拒绝持久化该字段；会话恢复依赖 Session metadata，不依赖写回配置文件 (`packages/cli/src/config/ConfigService.ts`, `packages/cli/src/store/vanilla.ts`)
- `ConfigService.save()` 对未知更新字段直接报错，但写现有文件时保留磁盘中的未知字段；这是输入契约严格、旧版本数据向前兼容的刻意组合 (`packages/cli/src/config/ConfigService.ts`)
- 防抖保存发生在 timer 回调内，失败只记录到 `lastSaveError` 而不会回抛到早先的 `save()` 调用；需要事务语义的权限决策和模型生命周期必须使用 `immediate: true` 或专用原子动作 (`packages/cli/src/config/ConfigService.ts`)
- 项目未信任时，项目层只能暴露 Hook 摘要并可设置 `disableAllHooks=true` 收紧行为；env、模型、MCP、permissionMode 和 allow 规则全部忽略 (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/tests/unit/services/workspace-model-resources.test.ts`)
- Web 对指定 `workspacePath` 调用 `setCurrentModel()` 时只更新当前客户端选择，不写入启动项目全局配置；无 workspace 参数时才通过 `/configs` 持久化 (`packages/cli/web/src/store/ConfigStore.ts`)
- Web 模型发现使用递增 sequence 丢弃迟到响应；移除该保护会让项目 A 的慢响应覆盖已切换到项目 B 的模型列表 (`packages/cli/web/src/store/ConfigStore.ts`, `packages/cli/web/tests/store/ConfigStore.test.ts`)

## Architecture
- `ConfigManager` 只负责 bootstrap/read/normalize/validate，Zustand Store 是启动表面的内存状态，`ConfigService` 是唯一磁盘写入路由；业务代码不应直接修改 JSON 配置 (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/src/config/ConfigService.ts`, `packages/cli/src/store/slices/configSlice.ts`)
- 配置优先级是默认值 < 用户 config/settings < 可信项目 config/settings < local settings < 显式 invocation/CLI；环境变量插值在合并和字符串清理后递归执行 (`packages/cli/src/config/ConfigManager.ts`)
- `resolveWorkspaceModelResources()` 在深复制配置后创建 Session 私有 `PiModelCatalog`；CredentialStore 可共享，但 Provider definitions、endpoint 和 fallback 注册不共享可变状态 (`packages/cli/src/agent/resources/WorkspaceModelResources.ts`)

## Decisions
- 模型凭据从 `models` 和 `modelProviders` 分离到 `auth.json`，旧字段会被验证器主动拒绝而不是静默迁移，避免 endpoint 与 credential 身份混淆 (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/src/config/modelProviders.ts`, `git:311ba368`)
- 配置文件写入统一使用 per-file mutex、read-modify-write 和 `0600` 原子替换，既保留未知字段，也避免并发 UI、CLI 与审批写入互相覆盖 (`packages/cli/src/config/ConfigService.ts`)
- 插件来源策略采用 tighten-only 合并：项目层只能开启更严格布尔限制或缩小 allowlist，不能覆盖用户级限制 (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/src/config/pluginSettings.ts`)

## Patterns
- 新增持久化字段时，以 `FIELD_ROUTING_TABLE` 为单一写入路由源，并同步 `BladeConfig`、`DEFAULT_CONFIG`、`validateConfig()` 和公开 API 投影 (`packages/cli/src/config/ConfigService.ts`, `packages/cli/src/config/types.ts`, `packages/cli/src/config/defaults.ts`)
- 涉及多个磁盘字段和运行时 catalog 的动作先保存完整内存快照，任何持久化失败都同时恢复 Store 与 catalog (`packages/cli/src/store/vanilla.ts`, `packages/cli/src/server/routes/provider.ts`)
- 配置中的字符串会递归 trim 并移除包裹反引号，随后 `$VAR`、`${VAR}` 和 `${VAR:-default}` 在嵌套对象与数组中统一展开 (`packages/cli/src/config/ConfigManager.ts`, `git:9513f0d2`)

## Consumer Analysis
- SessionRuntime 是最大消费者，按 source project 组合模型、MCP、LSP、权限和 Hook，再冻结到 Runtime (`packages/cli/src/agent/runtime/SessionRuntime.ts`)
- Server 路由通过 `configActions` 更新设置，并为多项目请求传入精确 workspace 身份 (`packages/cli/src/server/routes/`)
- 插件系统读取 workspace 启用状态与 tighten-only 来源策略，生命周期写入必须指定 scope (`packages/cli/src/plugins/`)
- MCP 与 LSP 不复用启动 Store 的项目层，分别调用 workspace 定向解析器 (`packages/cli/src/mcp/`, `packages/cli/src/lsp/`)
- Web Store 维护乐观 UI 状态、请求去重和失败回滚，但服务端配置仍是持久化权威 (`packages/cli/web/src/store/`)
