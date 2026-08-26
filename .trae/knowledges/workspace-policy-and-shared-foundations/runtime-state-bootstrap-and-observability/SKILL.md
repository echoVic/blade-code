---
name: knowledge-runtime-state-bootstrap-and-observability
description: >
  覆盖 Blade 的进程启动目录状态、跨异步上下文 cwd 隔离、共享 Vanilla Store、日志与运行环境观测、运行时包信息、Session ID、原生目录选择和项目注册。
  使用时机：调整 CLI 启动顺序、排查多 workspace 状态串扰、从 React 外访问 Store、增加运行态观测、修改版本识别、Session 标识或项目选择/绑定流程。
  不包含：配置层级与持久化路由见 layered-configuration-and-runtime-settings，事件日志与持久投影见 durable-transcript-and-event-projection，容量和关闭编排见 capacity-lifecycle-and-egress。
  关键词：bootstrap state, getCwd, runWithCwdOverride, vanillaStore, ensureStoreInitialized, Logger, streamDebug, getEnvironmentContext, getVersion, createSessionId, NativeDirectoryPicker, ProjectRegistry。
---

## Module Structure

该组件提供各运行表面共享的进程级基础状态与观测入口；它区分启动目录、当前工作区和稳定项目根，并把 UI 状态、日志、环境探测及项目发现收敛到可被 Agent、CLI、Server、工具和扩展复用的 API。

### Directory Layout
- `packages/cli/src/bootstrap/state.ts` — 惰性初始化的 cwd、originalCwd 与 projectRoot 三态
- `packages/cli/src/store/` — React 与非 React 共用的 Zustand Store、切片、类型和细粒度选择器
- `packages/cli/src/logging/` — 分类 JSONL 日志与独立流式调试日志
- `packages/cli/src/utils/cwd.ts` — 基于 AsyncLocalStorage 的并发 cwd 覆写
- `packages/cli/src/utils/environment.ts` — 项目根发现、环境提示和目录概览
- `packages/cli/src/utils/packageInfo.ts` — 源码与打包布局兼容的运行时包信息
- `packages/cli/src/utils/sessionId.ts` — 可安全用于存储路径的 Session ID
- `packages/cli/src/services/DirectoryPicker.ts` — macOS、Windows 与 Linux 原生目录选择
- `packages/cli/src/services/ProjectRegistry.ts` — 规范化项目路径的持久绑定注册表

### Key Entry Points
- `getCwd()` / `runWithCwdOverride()` — 获取当前执行上下文的 workspace，或为异步调用链临时覆写
- `vanillaStore` / `useBladeStore()` / `ensureStoreInitialized()` — 共享状态实例、React 订阅与幂等配置初始化
- `createLogger()` / `setLoggerSessionId()` / `streamDebug()` — 分类日志、会话日志路由与流式专项诊断
- `getEnvironmentContext()` / `getVersion()` / `createSessionId()` — 构造环境上下文、读取运行版本和生成存储安全标识
- `NativeDirectoryPicker.pick()` / `ProjectRegistry.list()` — 选择本机目录并读取规范化项目集合

## API Surface

### Workspace Location
- `getCwd()` — 优先返回当前 AsyncLocalStorage 覆写，否则返回进程级 cwd
- `runWithCwdOverride(cwd, fn)` — 在同步及后续异步调用链内隔离 workspace
- `getOriginalCwd()` — 返回 CLI 被调用时的原始目录，用于解析用户传入的相对路径
- `getProjectRoot()` — 返回启动后保持稳定的项目标识根
- `findProjectRoot(startDir)` / `setCwd(newPath, relativeTo?)` — 发现工作区根并更新规范化的全局 cwd

### Shared Store
- `useBladeStore(selector)` — React 对共享 Vanilla Store 的细粒度订阅入口
- `getState()` — Agent、服务与命令读取当前 Store 快照
- `sessionActions()` / `appActions()` / `configActions()` — 面向不同状态域的动作入口
- `ensureStoreInitialized()` — 以共享 Promise 合并并发配置初始化
- `useCurrentStreamingBuffer()` — 以浅比较订阅流式行缓冲、尾部、计数和版本

### Observability
- `createLogger(category, options?)` — 创建分类日志器，文件输出与终端调试过滤相互独立
- `Logger.setGlobalDebug(config)` — 动态设置全局终端日志开关或分类过滤
- `setLoggerSessionId(sessionId)` — 切换后续 JSONL 日志的文件名
- `streamDebug(source, message, data?)` — 向独立流式诊断文件追加记录且不向调用方抛错
- `getEnvironmentContext(options?)` — 组装系统、Git、脚本和目录信息供系统提示使用

### Runtime Identity And Project Discovery
- `getPackageInfo()` / `getVersion()` — 从运行时邻近 package.json 读取并缓存实际发布信息
- `createSessionId(prefix?, size?)` — 校验前缀后生成可用于文件名的 ID
- `NativeDirectoryPicker.pick()` — 跨平台打开至多一个并发原生目录选择器
- `ProjectRegistry.bind()` / `list()` / `unbind()` — 规范化、持久化并查询项目绑定

## Usage Examples

### CLI 启动时固定项目根
```typescript
const invocationCwd = process.cwd();
const detectedRoot = findProjectRoot(invocationCwd);
setCwd(detectedRoot);
setProjectRoot(getCwd());
```

### 启动 Server 前确保共享 Store 可用
```typescript
await ensureStoreInitialized();
const server = await BladeServer.listenAsync(opts);
```

### TUI 初始化完成后绑定会话日志
```typescript
const state = getState();
const sessionId = state.session.sessionId;
setLoggerSessionId(sessionId);
```

## Gotchas
- `originalCwd`、`cwd` 与 `projectRoot` 不能互换：CLI 相对参数以调用目录解析，运行工具使用可变 cwd，历史、Skill 和 Session 等项目身份使用启动后固定的 projectRoot (`packages/cli/src/bootstrap/state.ts`, `packages/cli/src/blade.tsx`, `packages/cli/src/cli/settings.ts`, `packages/cli/src/mcp/loadMcpConfig.ts`)
- CLI 必须先执行 `findProjectRoot()`、`setCwd()` 和 `setProjectRoot()` 再启动依赖 workspace 的流程，否则配置、信任与资源发现会以调用子目录为根 (`packages/cli/src/blade.tsx`, `packages/cli/src/utils/environment.ts`)
- 并发 Session 或子代理不能用全局 `setCwd()` 做临时切换；应使用 `runWithCwdOverride()`，其 AsyncLocalStorage 覆写会沿异步调用链传播且不污染其他执行上下文 (`packages/cli/src/utils/cwd.ts`, `git:4543542b`)
- `setCwd()` 解析相对路径时默认基于真实 `process.cwd()` 而不是当前 AsyncLocalStorage 覆写；在隔离上下文内传相对路径必须显式提供 `relativeTo` (`packages/cli/src/utils/environment.ts`, `packages/cli/src/utils/cwd.ts`)
- Store 是否初始化仅以 `config.config !== null` 判断；CLI、Server、ACP 和 Hook 等非 React 入口在读取配置前都必须等待 `ensureStoreInitialized()`，并发调用会共享同一个初始化 Promise (`packages/cli/src/store/vanilla.ts`, `packages/cli/src/commands/serve.ts`, `packages/cli/src/acp/BladeAgent.ts`)
- `resetSession()` 只重置 Zustand 内的 Session 字段并保留 sessionId，不会隐式清空模块级 `conversationProjection`；切换事件流时还要显式调用 `resetConversationProjection()` (`packages/cli/src/store/slices/sessionSlice.ts`)
- `Logger` 的 debug 开关只控制终端输出，所有级别仍同步追加到 JSONL；不要通过关闭 debug 假设磁盘日志已停用 (`packages/cli/src/logging/Logger.ts`)
- 日志文件路由使用进程级 `currentSessionId` 而非异步上下文；TUI 绑定 Session 前的记录进入 `blade-default.jsonl`，该机制也不能区分并发 Server Session (`packages/cli/src/logging/Logger.ts`, `packages/cli/src/ui/App.tsx`)
- 日志目录初始化只尝试一次；权限或创建失败后会缓存不可用状态，当前进程内即使外部修复目录也不会自动重试 (`packages/cli/src/logging/Logger.ts`)
- `streamDebug()` 不受 `Logger.setGlobalDebug()` 控制，并会在每个 storage root 的首次调用时重写 `stream-debug.log`；它是临时专项诊断通道，不是普通分类日志 (`packages/cli/src/logging/StreamDebugLogger.ts`, `packages/cli/src/ui/utils/loopEventHandler.ts`)
- `ProjectRegistry` 遇到缺失、损坏或版本不匹配的注册表会按空集合继续，并始终临时注入当前项目；因此列表只剩当前项目不代表绑定从未存在 (`packages/cli/src/services/ProjectRegistry.ts`, `packages/cli/tests/unit/services/project-registry.test.ts`)
- 原生目录选择服务本身不校验请求来源，只有 Server 路由拒绝非本机 Origin；新增调用表面时必须复用同等访问边界 (`packages/cli/src/services/DirectoryPicker.ts`, `packages/cli/src/server/routes/projects.ts`)
- Linux 目录选择仅在命令不存在时从 `zenity` 回退到 `kdialog`；已安装选择器返回真实错误时会立即失败，而空输出的退出码 1 被视为用户取消 (`packages/cli/src/services/DirectoryPicker.ts`, `packages/cli/tests/unit/platform/services/directory-picker.test.ts`)

## Architecture
- `bootstrap/state.ts` 保存进程级三态，`cwd.ts` 只在其上增加异步上下文覆盖；绝大多数业务代码应依赖 `getCwd()`，只有启动和测试夹具直接操作底层状态 (`packages/cli/src/bootstrap/state.ts`, `packages/cli/src/utils/cwd.ts`)
- 单一 `vanillaStore` 同时服务 Ink React 订阅和 Agent、服务、命令的命令式访问；Store 不使用 persist 中间件，配置和会话持久化分别交给 ConfigService 与 Context/JSONL (`packages/cli/src/store/index.ts`, `packages/cli/src/store/vanilla.ts`)
- Session Store 同时投影持久消息、临时流式缓冲和 Provider/停滞/重试等观测事件；命令结束或取消会集中清除易过期的运行态诊断，避免下一轮展示旧状态 (`packages/cli/src/store/slices/sessionSlice.ts`, `packages/cli/src/store/slices/commandSlice.ts`, `git:2aa2b22b`, `git:e6bd4e15`)
- `getEnvironmentContext()` 默认采集 Git 分支、工作树、最近提交、根目录清单和常用脚本；单项命令失败只省略对应片段，不会阻断提示构建 (`packages/cli/src/utils/environment.ts`, `packages/cli/tests/unit/platform/utils/environment.test.ts`, `git:7680e3eb`)
- 项目根发现会继续向上寻找 `.git`、`.blade` 或 `.claude`，仅在没有这些标记时回退到最近的 package.json，因此 monorepo 子包默认归属仓库根 (`packages/cli/src/utils/environment.ts`, `packages/cli/tests/unit/platform/utils/environment.test.ts`)
- 项目注册表以 realpath 作为去重身份，保留已失联项目供用户修复或解绑，并把当前项目固定排在名称排序之前 (`packages/cli/src/services/ProjectRegistry.ts`, `packages/cli/tests/unit/services/project-registry.test.ts`)

## Decisions
- cwd 隔离采用 AsyncLocalStorage 而不是 `process.chdir()`，使并行子代理、ACP 和真实 API 驱动可在同一进程内保持各自 workspace (`packages/cli/src/utils/cwd.ts`, `packages/cli/tests/support/browserToolAcpDriver.ts`)
- Zustand 只承担当前进程读模型，不承担磁盘权威状态；这一边界允许 Session 事件日志和配置服务独立处理恢复、原子写与版本迁移 (`packages/cli/src/store/vanilla.ts`, `packages/cli/src/store/types.ts`)
- 包版本改为从源码或 bundle 邻近目录向上搜索名称匹配的 package.json，避免发布包仍报告构建时导入的旧版本；找不到时才使用导入值或 `BLADE_VERSION` (`packages/cli/src/utils/packageInfo.ts`, `git:092d356b`)
- Session ID 统一由带受限前缀的 nanoid 生成，替代可能包含路径非法字符的临时标识，使 TUI、Web、ACP、任务和子代理共享存储安全格式 (`packages/cli/src/utils/sessionId.ts`, `packages/cli/src/store/slices/sessionSlice.ts`, `git:d148a8fa`)

## Patterns
- React 消费者通过专用 selector 订阅最小状态片段，对对象组合使用 `useShallow`，空模型列表复用常量引用；非 React 消费者通过 `getState()` 和动作访问器共享同一实例 (`packages/cli/src/store/index.ts`, `packages/cli/src/store/selectors/index.ts`, `packages/cli/src/store/vanilla.ts`)
- Store action 在并发清理时使用身份或请求 ID 防止迟到回调覆盖新状态，例如 `clearAbortController(expectedController)` 和旁路对话完成动作都先核对当前所有者 (`packages/cli/src/store/slices/commandSlice.ts`, `packages/cli/src/store/slices/appSlice.ts`)
- 项目绑定写入遵循 mutex 内 read-modify-write、原子替换和 `0600` 文件权限；目录本身同步收紧到 `0700` (`packages/cli/src/services/ProjectRegistry.ts`)
- `NativeDirectoryPicker.pick()` 缓存进行中的 Promise，并在 settle 后清空，多个并发 Web 请求只会打开一个系统对话框 (`packages/cli/src/services/DirectoryPicker.ts`, `packages/cli/tests/unit/platform/services/directory-picker.test.ts`)

## Dependencies
- 原生目录选择分别依赖 macOS `osascript`、Windows PowerShell Forms、Linux `zenity` 或 `kdialog`，统一受 15 分钟超时和 64 KiB 输出上限约束 (`packages/cli/src/services/DirectoryPicker.ts`)
- 日志和项目注册都从 Blade storage root 派生文件位置；前者容忍写入失败，后者使用 `write-file-atomic` 并向调用方传播非 ENOENT/语法错误 (`packages/cli/src/logging/Logger.ts`, `packages/cli/src/services/ProjectRegistry.ts`)

## Consumer Analysis
- TUI 是共享 Store 的最高频消费者，通过 selector 渲染消息、焦点和运行态，并通过动作协调初始化、模型、权限和日志 Session 绑定 (`packages/cli/src/ui/App.tsx`, `packages/cli/src/ui/hooks/useAgent.ts`, `packages/cli/src/store/selectors/index.ts`)
- Server 与 CLI 命令在无 React 环境调用 `ensureStoreInitialized()`、配置动作、环境版本和项目注册服务，启动顺序错误会直接影响 Web/Headless 可用性 (`packages/cli/src/commands/serve.ts`, `packages/cli/src/server/server.ts`, `packages/cli/src/server/routes/projects.ts`)
- Agent、SessionRuntime 与子代理使用共享 Store 投影运行状态，并以 `getCwd()` 或 AsyncLocalStorage 覆写确定每次执行的 workspace (`packages/cli/src/agent/Agent.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/agent/subagents/BackgroundAgentManager.ts`)
- 工具、Hooks、MCP、Plugins 和 LSP 广泛依赖 `getCwd()` 与分类 Logger；这些扩展必须优先使用显式 `context.workspaceRoot`，缺失时才回退进程上下文 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/hooks/HookManager.ts`, `packages/cli/src/plugins/PluginRegistry.ts`, `packages/cli/src/lsp/LspSessionManager.ts`)
- SessionService、PersistentStore 和协议适配层消费运行版本与存储安全 ID，把同一身份格式写入会话元数据、JSONL 路径、ACP 握手和 MCP 客户端信息 (`packages/cli/src/services/SessionService.ts`, `packages/cli/src/context/storage/PersistentStore.ts`, `packages/cli/src/acp/BladeAgent.ts`, `packages/cli/src/mcp/McpClient.ts`)
