---
name: knowledge-extension-ecosystem-plugin-lifecycle-and-marketplace
description: >
  覆盖插件发现、兼容性判断、安装/更新/卸载、Marketplace、来源策略和跨注册表资源投影。
  进入时机：修改插件生命周期、排查插件未激活或依赖错误、增加 Marketplace 来源、调整插件状态作用域或对接插件管理界面。
  不包含：MCP 协议内部语义（见 ../mcp-protocol-runtime/）、Skill 与自定义命令自身解析规则（见 ../skills-and-custom-commands/）、Hook 执行与信任细节（见 ../hooks-and-behavior-interception/）、LSP 会话协议（见 ../lsp-code-intelligence/）。
  关键词：PluginLifecycle、PluginInstaller、PluginRegistry、PluginLoader、PluginIntegrator、pluginSourcePolicy、enabledPlugins、Marketplace、--plugin-dir。
---

## Module Structure

插件域把可执行资源的来源校验、不可变安装、工作区发现、兼容性降级和 Session 前资源投影串成一条生命周期；HTTP、Slash Command、TUI 与 Web 只负责把用户意图送入同一协调层。

### Directory Layout
- `packages/cli/src/plugins/` — 插件清单、加载器、注册表、安装器、来源策略、兼容性与资源集成
- `packages/cli/src/config/pluginSettings.ts` — 启停作用域和来源策略输入归一化
- `packages/cli/src/server/routes/plugins.ts` — Web/HTTP 插件、Marketplace 与策略接口
- `packages/cli/src/slash-commands/plugins.ts` — CLI、Headless 与 ACP 共用的 `/plugins` 管理入口
- `packages/cli/src/ui/components/PluginsManager.tsx` — TUI 插件状态、更新和卸载界面
- `packages/cli/web/src/components/settings/PluginPanel.tsx` — Web 插件、来源策略与 Marketplace 管理面板
- `docs/reference/workspace-plugin-lifecycle.md` — 工作区插件生命周期行为契约
- `packages/cli/tests/unit/services/plugin-package-manager.test.ts` — 包存储、依赖事务和安全边界回归
- `packages/cli/tests/integration/real-api/plugin-marketplace-trajectory.test.ts` — 跨 ACP/Web 与新旧 Session 的真实轨迹验证

### Key Entry Points
- `setWorkspacePluginEnabled()` in `packages/cli/src/plugins/PluginLifecycle.ts` — 持久化指定层级并重新协调注册表
- `installWorkspacePlugin()` in `packages/cli/src/plugins/PluginLifecycle.ts` — 经过信任与来源策略后安装并刷新工作区投影
- `PluginInstaller.install()` in `packages/cli/src/plugins/PluginInstaller.ts` — 物化依赖闭包并提交内容寻址安装记录
- `PluginRegistry.initialize()` in `packages/cli/src/plugins/PluginRegistry.ts` — 按来源优先级发现插件并应用启停、策略和兼容性
- `PluginIntegrator.integrateAll()` in `packages/cli/src/plugins/PluginIntegrator.ts` — 将全部活跃插件作为一个集合投影到命令、Skill、Agent 与 Hook

## Gotchas
- 向 `global`、`project` 或 `local` 写入成功不等于请求状态最终生效，因为更具体层级仍可覆盖它；调用方必须展示返回的 `effectiveEnabled` 与 `effectiveScope`，不能只回显写入值 (`packages/cli/src/plugins/PluginLifecycle.ts`, `packages/cli/src/config/ConfigManager.ts`, `git:16b3d6d`)
- 未受信任工作区的项目配置只能收紧插件状态：其中的 `false` 会生效，`true` 会被忽略，同时项目插件目录完全不参与发现 (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/src/plugins/PluginRegistry.ts`)
- `--plugin-dir` 插件不受 `enabledPlugins` 开关控制且不能持久化切换，但仍会经过来源策略和兼容性检查，因此“invocation-scoped”不等于绕过安全校验 (`packages/cli/src/plugins/PluginLifecycle.ts`, `packages/cli/src/plugins/PluginRegistry.ts`)
- 修改插件状态或升级包只更新工作区注册表和后续 Session；已运行 Session 持有命令、Skill、Agent 与 Hook 的不可变快照，必须新建 Session 才能观察变化 (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`, `packages/cli/tests/integration/real-api/plugin-lifecycle-trajectory.test.ts`)
- Marketplace 刷新只替换目录快照，不会自动升级已经安装的插件；必须随后显式执行插件 update，旧 Session 仍继续读取旧内容根 (`packages/cli/src/plugins/PluginInstaller.ts`, `packages/cli/tests/integration/real-api/plugin-marketplace-trajectory.test.ts`)
- 自动 update/uninstall 只适用于包存储中有安装记录的受管插件；手工放入用户级或项目级插件目录的插件只能通过文件系统管理 (`packages/cli/src/plugins/PluginInstaller.ts`, `packages/cli/src/ui/components/PluginsManager.tsx`)
- 若 `.blade-plugin/plugin.json` 存在但内容非法，解析会直接失败而不会回退到 `.claude-plugin/plugin.json`；回退只发生在前一个清单不存在时 (`packages/cli/src/plugins/PluginManifest.ts`)
- 可选资源的坏文件不一定让整个插件失败：单个命令、Agent、Skill 会被警告后跳过，非法 Hook/MCP 配置可能退化为未加载该资源，排障时不能只看插件总体 `active` 状态 (`packages/cli/src/plugins/PluginLoader.ts`)
- 禁用、缺失、版本不匹配或来源策略拦截的依赖会通过固定点计算继续把所有上游依赖者降为 `error`；只修复顶层插件不会恢复依赖链 (`packages/cli/src/plugins/PluginCompatibility.ts`, `packages/cli/tests/unit/services/plugin-registry-compatibility.test.ts`)
- 收紧来源策略会重新检查已发现插件并可立即把现有插件置为 `error`，不是只约束下一次安装 (`packages/cli/src/plugins/PluginLifecycle.ts`, `packages/cli/src/plugins/PluginRegistry.ts`)
- Git 主机通配符 `*.example.test` 只匹配子域，不匹配 `example.test` 本身，也不会接受 `evilexample.test` 这类后缀混淆 (`packages/cli/src/plugins/PluginSourcePolicy.ts`, `packages/cli/tests/unit/services/plugin-source-policy.test.ts`)
- 卸载只移除账本投影并清理三个可编辑配置层的残留开关，不删除历史内容寻址目录；这是为仍引用旧根的活动 Session 保留的行为 (`packages/cli/src/plugins/PluginLifecycle.ts`, `packages/cli/tests/unit/services/plugin-package-manager.test.ts`)

## Architecture
- 生命周期协调层使用一个进程级 `lifecycleMutex` 串行化所有工作区的启停、策略、安装和 Marketplace 变更；包安装器再用实例互斥锁加 `0600` 文件锁保护跨实例账本写入 (`packages/cli/src/plugins/PluginLifecycle.ts`, `packages/cli/src/plugins/PluginInstaller.ts`)
- 运行链路是“发现并解析资源 → 应用开关与来源策略 → 固定点兼容性检查 → 清空并重建工作区投影 → 创建 Session 快照”，跳过重建会留下旧命令、Skill、Agent 或 Hook (`packages/cli/src/plugins/PluginRegistry.ts`, `packages/cli/src/plugins/PluginIntegrator.ts`, `packages/cli/src/agent/resources/WorkspaceAgentResources.ts`)
- 命令、Skill 与 Agent 在工作区注册表中立即集成，Hook 按全部活跃插件一次性交换；MCP 与 LSP 只保留带命名空间的定义，由每个 Session 按其精确工作区重新解析 (`packages/cli/src/plugins/PluginIntegrator.ts`, `packages/cli/src/mcp/resolveWorkspaceMcpConfig.ts`, `packages/cli/src/lsp/WorkspaceLspResources.ts`)
- 注册表按规范化工作区路径隔离；同名资源的插件来源优先级为 CLI 最高、项目高于受管/用户来源，工作区未获信任时项目来源被整体排除 (`packages/cli/src/plugins/PluginRegistry.ts`, `packages/cli/src/plugins/PluginLoader.ts`)
- Hook 集成先保存不含插件的基线，再把全部插件 matcher 合并成单个有效配置；恢复时校验注册表实例身份，避免被淘汰的旧资源代际覆盖新配置 (`packages/cli/src/plugins/PluginIntegrator.ts`, `git:2db1b23`)

## Decisions
- 受管包采用内容寻址不可变目录和原子 `0600` 账本，新版本切换记录而不原地覆盖文件，使活动 Session 可继续安全读取旧版本 (`packages/cli/src/plugins/PluginInstaller.ts`, `git:889e906`)
- 只有同一 Marketplace 的依赖能被递归自动安装；直接 Git/本地来源和跨 Marketplace 依赖要求显式安装，避免从未声明的目录隐式执行代码 (`packages/cli/src/plugins/PluginInstaller.ts`)
- 项目与 local 层的来源策略采用只收紧语义：布尔限制只能从假变真，allowlist 只能求交集，`BLADE_PLUGIN_REQUIRE_SHA` 还能在宿主层强制完整 SHA (`packages/cli/src/config/ConfigManager.ts`)
- 来源信任、Workspace Trust 与 Hook Trust 是三个独立门：安装或更新可执行内容需要显式来源确认，本地来源还要求工作区可信，插件 Hook 启用后仍需内容摘要审批 (`packages/cli/src/plugins/PluginLifecycle.ts`, `packages/cli/src/plugins/PluginInstaller.ts`, `docs/reference/workspace-plugin-lifecycle.md`)

## Patterns
- 任何会改变活跃集合的操作都先清除旧插件投影，再刷新或重算注册表，随后完整集成全部活跃插件并刷新通信风格；不得只增量注册单个插件资源 (`packages/cli/src/plugins/PluginLifecycle.ts`, `packages/cli/src/plugins/PluginIntegrator.ts`)
- `global` 状态或策略变更会协调进程内所有已初始化工作区注册表，`project`/`local` 只协调目标工作区；受管安装更新因共享用户包存储也会刷新全部已初始化注册表 (`packages/cli/src/plugins/PluginLifecycle.ts`)
- 安装和更新先物化并验证完整依赖闭包，检测循环、身份和版本后才发布目录并写账本；失败时清理 staging 且不留下部分安装记录 (`packages/cli/src/plugins/PluginInstaller.ts`, `packages/cli/tests/unit/services/plugin-package-manager.test.ts`)
- 卸载前同时保护两类反向引用：插件依赖者会得到 `PLUGIN_REQUIRED`，仍由 Marketplace 拥有的安装会让 Marketplace 删除得到 `MARKETPLACE_IN_USE` (`packages/cli/src/plugins/PluginLifecycle.ts`, `packages/cli/src/plugins/PluginInstaller.ts`)

## Conventions
- 插件命令、Skill 与 Agent 使用 `plugin-name:resource-name`，MCP 使用 `plugin-name__server-name`，LSP 使用 `plugin:plugin-name:server-name`；新增资源消费者必须沿用各自命名空间而不能假设统一分隔符 (`packages/cli/src/plugins/namespacing.ts`, `packages/cli/src/plugins/PluginLoader.ts`)
- 所有管理表面都委托 `PluginLifecycle`：HTTP 请求要求绝对 `projectPath`，安装/更新要求字面量 `trust: true`，卸载和 Marketplace 删除要求字面量 `confirm: true` (`packages/cli/src/server/routes/plugins.ts`, `packages/cli/src/slash-commands/plugins.ts`)
- 插件名和依赖名只接受小写字母、数字与内部连字符，长度上限 64；配置、清单、Marketplace 和账本共享这一身份约束，不能在某一入口单独放宽 (`packages/cli/src/config/pluginSettings.ts`, `packages/cli/src/plugins/PluginInstaller.ts`, `packages/cli/src/plugins/PluginCompatibility.ts`)

## Dependencies
- Git 来源只允许 HTTPS、SSH 或受限的 SCP 风格地址，禁止 URL 内凭据和 query/fragment ref；Git 通过 `execFile` 参数数组执行并关闭交互式凭据提示 (`packages/cli/src/plugins/PluginInstaller.ts`, `packages/cli/tests/unit/services/plugin-installer-git.test.ts`)
- `semver` 同时约束 Blade 版本、安装期依赖闭包和注册表加载期依赖图；变更 manifest 约束时必须覆盖安装失败与已有插件降级两条路径 (`packages/cli/src/plugins/PluginInstaller.ts`, `packages/cli/src/plugins/PluginCompatibility.ts`)

## Storage And Integrity
- 内容摘要按相对路径、可执行位和文件内容计算且忽略 `.git`；修改脚本执行位也会被视为包内容变化，受管包在加载前会重新哈希以检测篡改 (`packages/cli/src/plugins/PluginInstaller.ts`)
- 包物化拒绝符号链接、非普通文件、超过 10000 个文件或 100 MiB 的目录，Marketplace 相对条目在解析前后都要留在其真实根目录内 (`packages/cli/src/plugins/PluginInstaller.ts`)
- 完整 SHA 策略在网络访问前拒绝分支或短 SHA，并在 checkout 后再次比对 `HEAD`；策略关闭来源 allowlist 时也不会关闭 SHA 要求 (`packages/cli/src/plugins/PluginSourcePolicy.ts`, `packages/cli/src/plugins/PluginInstaller.ts`)
- 包存储锁只有当前用户拥有、权限为 `0600` 且超过陈旧阈值时才会被回收；异常锁文件会让操作失败关闭而不是冒险并发写账本 (`packages/cli/src/plugins/PluginInstaller.ts`)
