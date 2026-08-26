---
name: knowledge-extension-ecosystem-lsp-code-intelligence
description: >
  覆盖 Session 级 LSP 配置快照、stdio 进程、文档同步、语义查询、诊断回注、崩溃恢复
  和子 Session 继承。进入条件：新增语言服务器、修改 LSP 工具、排查诊断缺失/重复、
  处理 worktree 或 ACP 差异、修复进程泄漏或 transport 代际问题。不包含：VS Code
  扩展桥接（见 ../../interaction-surfaces/vscode-bridge/）、通用进程管理（见
  ../../tool-and-automation-platform/shell-process-and-worktree/）。关键词：
  LspSessionManager、LspClient、WorkspaceLspResources、publishDiagnostics、LSP。
---

## Module Structure

LSP 配置按 source project 解析并冻结，`SessionRuntime` 再以 execution workspace
创建私有 manager；语言服务器按目标文件扩展名懒启动，语义查询和写后诊断共享同一连接。

### Directory Layout
- `packages/cli/src/lsp/` — LSP client、Session manager 与 Workspace 资源快照
- `packages/cli/src/config/lspSettings.ts` — LSP server 配置规范化和硬边界
- `packages/cli/src/tools/builtin/lsp/` — ReadOnly LSP 工具与协议结果格式化
- `packages/cli/src/ide/` — IDE 检测和 Blade IDE 扩展安装入口
- `docs/reference/lsp-session-intelligence.md` — Session LSP 行为契约与资格要求

### Key Entry Points
- `resolveWorkspaceLspResources()` in `packages/cli/src/lsp/WorkspaceLspResources.ts` — 合并用户、项目和插件服务器并冻结快照
- `LspSessionManager.query()` in `packages/cli/src/lsp/LspSessionManager.ts` — 执行语义查询
- `LspSessionManager.afterToolUse()` in `packages/cli/src/lsp/LspSessionManager.ts` — 写后同步并回注新诊断
- `LspClient.start()` / `LspClient.stop()` in `packages/cli/src/lsp/LspClient.ts` — 管理 stdio JSON-RPC 与 owned process tree
- `createLspTool()` in `packages/cli/src/tools/builtin/lsp/lsp.ts` — 将 manager 暴露为统一只读工具

## API Surface

### Workspace LSP Resources
- `resolveWorkspaceLspResources(projectRoot, base)` — 合并 Workspace 配置和插件 `.lsp.json`
- `snapshotWorkspaceLspResources(resources)` — 规范化、深拷贝并冻结 Session 配置

### LspSessionManager
- `available` — 仅在存在启用服务器、Session 非 ACP remote 且未 dispose 时为真
- `query(input, signal)` — 路由 definition、references、hover、symbols、implementation、call hierarchy 或 diagnostics
- `afterToolUse(toolName, params, result, context)` — 同步成功写操作并把新诊断追加到 ToolResult
- `getStatus()` — 返回服务器状态、重启次数、扩展映射和最近错误
- `dispose()` — 解除 waiter、发送 shutdown/exit 并回收所有服务器进程

### LspClient
- `start(options)` / `initialize(params, timeout, signal)` — 建立 stdio transport 与协议握手
- `request(method, params, timeout, signal)` — 带 JSON-RPC cancellation 和本地 timeout 的请求
- `stop(timeout)` — 尝试协议关闭后以 owned process tree 作为最终回收边界

## Usage Examples

### Session 创建私有 Manager (`packages/cli/src/agent/runtime/SessionRuntime.ts`)
```typescript
this.lspManager = new LspSessionManager({
  sessionId: this.sessionId,
  workspaceRoot: this.workspaceRoot,
  environment: this.sessionEnvironment,
  servers: this.lspResources.servers,
});
```

### 工具成功后同步诊断 (`packages/cli/src/tools/execution/ToolExecutor.ts`)
```typescript
await runPostToolUseHooks(tool, params, result, context, hookResult.toolUseId);
if (context.signal?.aborted) return createCancellationResult(false);
await this.lspManager?.afterToolUse(tool.name, params, result, context);
```

### 子代理继承父 Session 快照 (`packages/cli/src/agent/subagents/SubagentExecutor.ts`)
```typescript
runtime = await SessionRuntime.create({
  sessionId: agentId,
  workspaceRoot,
  agentResources: this.agentResources,
  modelResources: this.modelResources,
  lspResources: this.lspResources,
});
```

## Gotchas
- ACP remote Session 即使带有 LSP 配置也不会启动宿主本地服务器，`query()` 会明确返回 remote-files unavailable；不能把 IDE 远端路径交给本地 realpath(`packages/cli/src/lsp/LspSessionManager.ts`)
- 只要本地 Session 配置了至少一个启用服务器，`available` 就为真并关闭 AutoVerify fallback；服务器后续启动失败或没有覆盖某类文件时不会自动恢复 package-script 验证(`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/lsp/LspSessionManager.ts`)
- 同一扩展名只选择一个 server，规则是 priority 降序、名称升序；配置多个同语言服务器不会并行聚合诊断或查询结果(`packages/cli/src/lsp/LspSessionManager.ts`)
- `LSP` 工具接收 1-based line/character，manager 在发协议请求前转为 0-based；直接调用 manager API 时也应遵循工具侧 1-based 契约(`packages/cli/src/tools/builtin/lsp/lsp.ts`, `packages/cli/src/lsp/LspSessionManager.ts`)
- 目标文件先 realpath 并验证位于 Session workspace 内；symlink 逃逸会拒绝，删除文件则通过最近存在祖先重建 canonical path 后再发送 didClose(`packages/cli/src/lsp/LspSessionManager.ts`)
- 只有成功的 Write/Edit 和带标准 `metadata.changes` 的 ApplyPatch 会触发同步；失败结果、其他写工具或自定义 metadata 不会产生 didChange/didSave(`packages/cli/src/lsp/LspSessionManager.ts`)
- 写后诊断在 PostToolUse Hook 之后、AutoVerify 之前追加到同一 ToolResult；Hook 看不到本次新 LSP 诊断，模型看到的最终结果则可以包含两者(`packages/cli/src/tools/execution/ToolExecutor.ts`)
- 诊断按内容 hash 跨轮去重，每文件最多注入 10 条、单次最多 30 条；重复问题仍可通过显式 `diagnostics` 查询看到，但不会反复附加到写工具结果(`packages/cli/src/lsp/LspSessionManager.ts`)
- server crash 只把状态设为 error 并清空 opened-files；真正重启发生在下一次相关查询或写同步，超过 `maxRestarts` 后 fail closed(`packages/cli/src/lsp/LspSessionManager.ts`)
- 已 dispose transport 的迟到 child close 或 JSON-RPC close 必须被 identity guard 忽略，否则会把新 transport 错误标记为未初始化；该回归由独立代际测试锁定(`packages/cli/src/lsp/LspClient.ts`, `packages/cli/tests/unit/services/lsp-client.test.ts`, `git:8a29b24e`)
- 只有 JSON-RPC `ContentModified` 会最多重试 4 次并做指数退避；timeout、abort、server error 和其他协议错误都直接返回(`packages/cli/src/lsp/LspSessionManager.ts`)
- LSP 文件读取上限是 10 MiB，服务器 stderr 只保留前 64 KiB 且崩溃消息只带 512 字符预览；不能依赖完整 stderr 做长期诊断(`packages/cli/src/lsp/LspSessionManager.ts`, `packages/cli/src/lsp/LspClient.ts`)

## Architecture
- Workspace 配置先与受信项目配置合并，再由 active plugins 按名称覆盖，最后通过 `normalizeLspServers()` 深拷贝并冻结；Session 不观察后续插件刷新(`packages/cli/src/lsp/WorkspaceLspResources.ts`, `packages/cli/src/config/lspSettings.ts`)
- 每个 Session/server 拥有独立进程、connection、opened-file versions、diagnostics、waiters 和 restart count；同名服务器不会跨 Session 共享状态(`packages/cli/src/lsp/LspSessionManager.ts`, `packages/cli/tests/integration/lsp-session-manager.test.ts`)
- 文档首次访问发送 didOpen version 1，后续写入发送全量 didChange、didSave 并短暂等待新的 diagnostics sequence；删除发送 didClose 并清除缓存(`packages/cli/src/lsp/LspSessionManager.ts`)
- LspClient 使用 `spawnOwnedProcess()` 启动不经 shell 的命令参数，优先协议 shutdown/exit，最终以进程树终止保证子进程不残留(`packages/cli/src/lsp/LspClient.ts`)

## Decisions
- LSP 采用 Session 私有而非进程共享架构，是为了让 worktree、并行 Session、子代理和不同环境变量拥有确定的文档版本与诊断状态(`packages/cli/src/lsp/LspSessionManager.ts`, `git:8a878e32`)
- 配置规范化拒绝未知字段并对服务器数、参数、扩展、JSON options、timeout 和 restart 设置硬上限，避免插件或项目配置创建无界运行时(`packages/cli/src/config/lspSettings.ts`)
- LSP 工具标记为 ReadOnly、并发安全和可重试，但写后诊断属于 ToolExecutor side effect；新增语义操作应走 manager/query，而不是绕过 Session 生命周期直连 client(`packages/cli/src/tools/builtin/lsp/lsp.ts`, `packages/cli/src/tools/execution/ToolExecutor.ts`)

## Patterns
- extension key 统一转小写并补 `.`，同一文件的语言 ID 来自被选 server 的 `extensionToLanguage`；插件服务器名称在加载时加 `plugin:<name>:` 前缀(`packages/cli/src/config/lspSettings.ts`, `packages/cli/src/plugins/PluginLoader.ts`)
- request timeout 与 turn abort 都映射为 JSON-RPC cancellation，dispose 还会解析所有 diagnostics waiter，避免 Session 结束后留下等待 Promise(`packages/cli/src/lsp/LspClient.ts`, `packages/cli/src/lsp/LspSessionManager.ts`)

## Consumer Analysis
- `packages/cli/src/agent/runtime/SessionRuntime.ts` — 持有不可变配置、创建 manager、决定 LSP 与 AutoVerify 二选一并负责最终 dispose(`packages/cli/src/agent/runtime/SessionRuntime.ts`)
- `packages/cli/src/tools/execution/ToolExecutor.ts` — 在 PostToolUse 后调用 `afterToolUse()`，把增量诊断并入最终工具结果(`packages/cli/src/tools/execution/ToolExecutor.ts`)
- `packages/cli/src/tools/builtin/index.ts` — 仅当 manager 可用时注册 LSP 工具，避免暴露必然失败的 schema(`packages/cli/src/tools/builtin/index.ts`)
- `packages/cli/src/agent/subagents/SubagentExecutor.ts` 与 `packages/cli/src/agent/teams/TeamRuntime.ts` — 将父级 LSP 资源快照传给新 Runtime，但每个 child 仍创建独立进程与诊断状态(`packages/cli/src/agent/subagents/SubagentExecutor.ts`, `packages/cli/src/agent/teams/TeamRuntime.ts`)
- `packages/cli/src/plugins/PluginLoader.ts` — 读取 `.lsp.json`、展开 immutable plugin root 并命名空间化服务器；实际进程仍由 Session manager 延迟启动(`packages/cli/src/plugins/PluginLoader.ts`, `packages/cli/tests/unit/services/plugin-lsp-loader.test.ts`)
