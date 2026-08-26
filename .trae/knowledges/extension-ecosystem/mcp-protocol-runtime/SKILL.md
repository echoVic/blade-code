---
name: knowledge-extension-ecosystem-mcp-protocol-runtime
description: >
  覆盖 Session 私有 MCP transport、动态工具与内容目录、Roots、Sampling、Elicitation、
  Completion、Logging、OAuth、异步 Tasks、结果制品和故障恢复。进入条件：新增 MCP
  能力、调试连接或目录变化、处理不可信协议数据、修改 MCP 工具投影或跨端事件。
  不包含：通用工具准入与调度（见 ../../tool-and-automation-platform/）、插件安装和
  来源策略（见 ../plugin-lifecycle-and-marketplace/）。关键词：McpClient、
  McpRegistry、mcp__、tools/list_changed、elicitation、sampling、OAuth、MCP Tasks。
---

## Module Structure

MCP 运行时由每个 `SessionRuntime` 独占：配置先按 source project 合并，Registry 管理
多个 client 的安全投影，动态工具和内容能力再进入该 Session 的 ToolRegistry 与事件流。

### Directory Layout
- `packages/cli/src/mcp/` — client、registry、目录、交互、恢复、日志、任务与结果归一化
- `packages/cli/src/mcp/auth/` — OAuth 策略、回调 provider 与凭据账本
- `packages/cli/src/tools/builtin/mcp/` — Resources、Prompts、Completion 与 Tasks 工具适配
- `packages/cli/src/commands/mcp.ts` — 进程外 MCP 管理命令
- `packages/cli/src/server/routes/mcp.ts` — 当前 Web Session 的 MCP 管理 API
- `packages/cli/src/slash-commands/mcp.ts` — 活动 TUI/ACP Session 的 MCP 命令
- `packages/cli/web/src/components/mcp/` — Web MCP 状态与操作面板

### Key Entry Points
- `resolveWorkspaceMcpConfig()` in `packages/cli/src/mcp/resolveWorkspaceMcpConfig.ts` — 合并并规范化单个 Session 的 MCP 配置
- `McpRegistry.createIsolated()` in `packages/cli/src/mcp/McpRegistry.ts` — 创建 Session 独占 Registry
- `McpClient.connect()` and `McpClient.callTool()` in `packages/cli/src/mcp/McpClient.ts` — 建连、能力协商与工具调用
- `createMcpTool()` in `packages/cli/src/mcp/createMcpTool.ts` — 将协议工具映射为 Blade Tool
- `SessionRuntime.registerMcpTools()` in `packages/cli/src/agent/runtime/SessionRuntime.ts` — 注册动态目录、内容工具和事件监听

## Gotchas
- MCP 配置覆盖顺序是 workspace → plugin →显式 Session → CLI，`strictCliConfig` 会跳过前三类来源；相对 stdio `cwd` 始终按 source project 解析而不是 task worktree(`packages/cli/src/mcp/resolveWorkspaceMcpConfig.ts`)
- `--mcp-config` 的单个非法文件或 JSON 只记录 warning 并跳过，后续参数仍继续覆盖；调用方不能假设解析失败会使 Session 创建失败(`packages/cli/src/mcp/loadMcpConfig.ts`)
- `McpRegistry.registerServer()` 默认吞掉初始连接异常并保留 ERROR server，Session 可继续启动；需要通过状态或显式 reconnect 区分“已注册”与“已连接”(`packages/cli/src/mcp/McpRegistry.ts`)
- 同一 client 同时只允许一个交互式工具调用或 task 创建，因为 Elicitation/Sampling 缺少可靠的父调用关联；并发重叠会在发请求前拒绝(`packages/cli/src/mcp/McpClient.ts`)
- transport 进入恢复前会立即撤销旧 tools、resources、prompts 和 instructions；持有旧 `Tool` 对象或旧 catalog identity 重试会命中死亡 connection generation(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpRegistry.ts`)
- `list_changed` 通知只登记有界合并刷新，完整新目录全部校验成功后才替换；notification 刷新失败保留上一有效目录，而手动刷新会把错误返回调用方(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpToolCatalog.ts`)
- Resource subscription 分为 desired 与 active：异常断连只清 active 并在新目录确认 URI 后恢复，手动 disconnect、unsubscribe 或 Session dispose 才清 desired(`packages/cli/src/mcp/McpClient.ts`)
- MCP Tasks 默认关闭；`taskSupport=required` 的动态工具会自动后台化，`optional` 仍以前台调用为默认，只有显式 `StartMcpTask` 才进入 task 路径(`packages/cli/src/mcp/createMcpTool.ts`, `packages/cli/src/mcp/McpTasks.ts`)
- 模型和用户只能看到 Blade 生成的 `mcp_task_*`，原始 server task ID 必须留在 manager 内部；ownership 同时校验 Session ID 与 canonical execution workspace(`packages/cli/src/mcp/McpTaskManager.ts`, `packages/cli/src/tools/builtin/mcp/mcpTaskTools.ts`)
- 二进制结果绝不能把 base64 直接注入模型；大文本超过 inline budget 后写 Session 私有 artifact，写入失败也只能返回 hash/size/omitted 元数据(`packages/cli/src/mcp/McpToolResult.ts`, `packages/cli/src/mcp/McpToolArtifactStore.ts`)
- MCP 日志是用户诊断事件而非模型输入，server instructions 才会以明确标注“不可信外部文档”的 scoped reminder 进入 provider boundary；二者不能共用注入路径(`packages/cli/src/mcp/McpLogging.ts`, `packages/cli/src/mcp/McpServerInstructions.ts`)

## Architecture
- 每个 Session 创建独立 `McpRegistry`、client、目录 revision 和 artifact writer，进程级 Store 仅用于启动表面的配置投影，不能作为运行时连接来源(`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/mcp/McpRegistry.ts`, `git:6d712a03`)
- 动态工具身份固定为 `mcp__<server>__<tool>`；不安全或过长片段经 NFKC 与摘要后缀规范化，避免 server 同名工具覆盖彼此或覆盖内置工具(`packages/cli/src/mcp/McpToolCatalog.ts`)
- Agent 发起下一次 provider 请求前等待 catalog barrier，随后把完整 MCP 投影一次替换到基础 registry 和每个 executor，并重新应用 whitelist/blacklist(`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/tools/registry/ToolRegistry.ts`)
- 工具调用同时受父 `AbortSignal`、idle timeout 和 hard total timeout 约束；合法 progress 刷新 idle timeout，但不能延长 hard timeout，也不会写入 durable transcript(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpCallLifecycle.ts`)
- Resources、templates 和 prompts 使用独立 revision 与 delta；资源与模板同批获取后提交，读取和 prompt 解析只接受当前 catalog 已声明的 identity(`packages/cli/src/mcp/McpContentCatalog.ts`, `packages/cli/src/mcp/McpClient.ts`)
- Elicitation 在展示前和回传前分别经过 Hooks，最终响应仍按原始 requested schema 校验；没有交互面、取消、超时或异常统一收敛为 cancel/decline(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpElicitation.ts`)
- Sampling 使用当前 Session 冻结模型，按每次请求重新审批，并拒绝 tools、context 扩展、task sampling 和并发 nested request(`packages/cli/src/mcp/McpSampling.ts`, `packages/cli/src/mcp/McpClient.ts`)
- 异步 Task watcher 在 transport 不可用时进入 `interrupted` 并等待同一 client 恢复；恢复后必须验证原始 task ID 与 `createdAt` 未变化才继续取状态或结果(`packages/cli/src/mcp/McpTaskManager.ts`, `packages/cli/src/mcp/McpTasks.ts`)

## Decisions
- MCP 全协议生命周期在一次集中改造中引入，并将目录、内容、交互、日志、任务和 OAuth 都纳入 Session 隔离，而不是继续扩展进程全局 registry(`packages/cli/src/mcp/McpRegistry.ts`, `packages/cli/src/mcp/McpClient.ts`, `git:7894b6e6`)
- Sampling 和 Tasks 均选择默认关闭、按 server 显式启用，因为二者会分别产生额外模型调用和后台生命周期，不能从普通工具授权隐式继承(`packages/cli/src/mcp/McpSampling.ts`, `packages/cli/src/mcp/McpTasks.ts`)
- Completion 被建模为只读候选数据而非控制消息，必须先绑定当前 catalog 中的 prompt 参数或 URI template variable，再做字符和结果预算归一化(`packages/cli/src/mcp/McpCompletion.ts`)
- tool result 与 MCP content 都采用“文本有界保留、二进制只给 provenance”的策略，避免协议返回绕过模型上下文预算和 Web 事件 allowlist(`packages/cli/src/mcp/McpToolResult.ts`, `packages/cli/src/mcp/McpContentCatalog.ts`)
- MCP artifact 后续迁移到共享的私有 Session 存储实现，新增结果类型应复用该存储而不是另建可见目录(`packages/cli/src/mcp/McpToolArtifactStore.ts`, `git:4553d089`)

## Patterns
- 所有会跨异步边界返回的协议对象先 `structuredClone` 或重新归一化，事件再附加单调 revision，防止 listener 修改 Registry 内部状态(`packages/cli/src/mcp/McpRegistry.ts`)
- 目录分页统一限制页数、条目数、重复 cursor、identity 和总字节；超限按整个目录失败处理，不提交部分目录(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpToolCatalog.ts`, `packages/cli/src/mcp/McpContentCatalog.ts`)
- 恢复、Completion、Tasks 和 resource subscription 都捕获当前 client/generation，异步结果返回时发现 client 已变化就拒绝，避免旧 transport 的迟到结果污染新连接(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpConnectionRecovery.ts`)

## Dependencies
- MCP transport、schema 和实验性 Tasks 依赖 `@modelcontextprotocol/sdk`；Blade 在 SDK 校验后仍执行自己的目录、结果、Unicode 和生命周期边界(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/package.json`)
- 动态 MCP 工具复用 Blade 的 TypeBox Tool contract、权限确认、进度事件和 `SessionArtifactStore`，因此协议层修改必须同时检查 ToolRegistry 与 SessionRuntime 投影(`packages/cli/src/mcp/createMcpTool.ts`, `packages/cli/src/mcp/McpToolArtifactStore.ts`)

## Security Considerations
- OAuth 只允许 HTTPS，loopback 可用 HTTP；禁止 URL credentials、手写 Authorization header 和旧式 secret/endpoint 字段，网络请求不跟随 redirect(`packages/cli/src/mcp/auth/McpOAuthPolicy.ts`)
- OAuth 凭据身份由 endpoint、client ID 和排序 scopes 哈希生成，账本与锁文件必须是当前用户拥有的普通 `0600` 文件，写入使用进程内 mutex、跨进程排他锁和原子替换(`packages/cli/src/mcp/auth/OAuthTokenStorage.ts`)
- ACP Session 不读取宿主 OAuth 凭据、不暴露本地 roots 或 artifact path，也不向模型投影 server instruction/log 正文(`packages/cli/src/agent/runtime/SessionRuntime.ts`, `docs/reference/mcp-session-isolation.md`)
- Form Elicitation 拒绝原型污染字段、额外属性和不安全数字；URL Elicitation 只接受无凭据的 HTTP(S) URL，敏感数据应留在外部 URL 流程(`packages/cli/src/mcp/McpElicitation.ts`)
- Prompt 与 Completion 参数必须来自当前 catalog 声明，未知参数、缺失 required 参数和 `__proto__`/`constructor`/`prototype` 在协议请求前拒绝(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpCompletion.ts`)
- 连接错误、Task status/error 与工具错误分别执行 URL、Bearer、API key、控制字符和 UTF-8 字节上限清理，不能把 transport 文本直接用作模型指令(`packages/cli/src/mcp/McpConnectionRecovery.ts`, `packages/cli/src/mcp/McpTasks.ts`, `packages/cli/src/mcp/McpToolResult.ts`)

## Error Handling & Recovery
- 自动恢复是 single-flight generation 状态机；手动 disconnect 或 dispose 会提升 generation、取消连接和退避，旧 close/error 回调不能覆盖新状态(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpConnectionRecovery.ts`)
- 只有 session-not-found、连续终端 transport 错误和健康检查阈值进入恢复；普通协议校验错误不会触发重连风暴(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/HealthMonitor.ts`)
- Session dispose 先取消当前 Session 的 MCP Tasks，再解除 Registry listener 并断开全部 client，防止终态事件写入已释放的执行器目录(`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/mcp/McpTaskManager.ts`)
