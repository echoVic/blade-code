---
name: knowledge-interaction-surfaces-acp-host-integration
description: >
  覆盖 Blade 的 ACP stdio Agent、Session load/list/fork/close、宿主能力协商、远程
  文件系统与终端、权限模式、流式 update、历史回放和资源回收。进入时机：接入 Zed 或
  其他 ACP 宿主、修改协议能力、调试远程文件/终端、Session 替换、输出背压或宿主工具
  展示。 不包含：普通 Web API（见 ../hono-server-api-and-streaming/）、本地 TUI
  交互（见 ../terminal-ui/）。关键词：BladeAgent, AcpSession, AcpServiceContext,
  AgentSideConnection, sessionUpdate, session/load, unstable_forkSession,
  requestPermission。
---

## Module Structure

ACP 层把每个宿主 Session 映射为独占的 Agent、SessionRuntime、文件系统/终端服务和
有界更新队列，通过 stdio NDJSON 与 IDE 通信。

### Directory Layout
- `packages/cli/src/acp/index.ts` — stdio Web Streams 与 ACP connection 生命周期
- `packages/cli/src/acp/BladeAgent.ts` — 协议方法、Session residency 和配置能力
- `packages/cli/src/acp/Session.ts` — prompt、历史、权限、LoopEvent 与 update 投影
- `packages/cli/src/acp/AcpServiceContext.ts` — 按 Session 隔离的 FS/Terminal 后端
- `packages/cli/src/acp/AcpFileSystemService.ts` — ACP 文本文件能力适配
- `packages/cli/src/services/FileSystemService.ts` — 本地/远程文件系统公共接口
- `packages/cli/src/tools/display/ToolResultProjector.ts` — ACP 工具详情裁剪

### Key Entry Points
- `runAcpIntegration()` in `packages/cli/src/acp/index.ts` — 建立 AgentSideConnection 并绑定关闭清理
- `BladeAgent.initialize()` in `packages/cli/src/acp/BladeAgent.ts` — 协商协议和 Agent 能力
- `BladeAgent.newSession()` and `BladeAgent.loadSession()` — 创建或原子替换宿主 Session
- `AcpSession.initialize()` in `packages/cli/src/acp/Session.ts` — 创建服务上下文、恢复交互和 Runtime
- `AcpSession.prompt()` in `packages/cli/src/acp/Session.ts` — 处理 prompt 并串行投影事件

## Gotchas
- `session/load` 必须在返回响应前按协议回放所有用户可见历史；system、tool 和内部消息留在模型上下文但不发送给宿主 (`packages/cli/src/acp/BladeAgent.ts`, `packages/cli/src/acp/Session.ts`, `git:6d712a03`)
- 同一个 Session 的并发 load/close 通过 `sessionLoadQueues` 串行，旧 owner 完全销毁后才能提交新 owner；否则两个 Runtime 会同时消费同一 durable inbox (`packages/cli/src/acp/BladeAgent.ts`, `git:804a5c64`)
- ACP Runtime residency 的 `allowEviction` 为 false；容量满时新 Session 直接返回结构化 internal error，不能静默逐出宿主仍持有的 Session (`packages/cli/src/acp/BladeAgent.ts`)
- 宿主声明 `fs.readTextFile`/`writeTextFile` 后，远端调用失败必须 fail closed，不能读取或写入 Agent 主机上的同名路径；只有未声明能力时才选择本地 FS (`packages/cli/src/acp/AcpFileSystemService.ts`)
- Terminal 后端在 Session 初始化时按 capability 选择：声明 terminal 后远端创建失败不自动本地执行，未声明 terminal 才使用绑定 Session cwd 的本地后端 (`packages/cli/src/acp/AcpServiceContext.ts`, `docs/testing/acp-terminal-capability-routing-evidence.md`, `git:4991291e`)
- ACP terminal 的 `currentOutput()` 是累计快照而非增量；轮询必须按已观察长度切 delta，输出回退或 truncated 时重建 capture 并标记 accounting incomplete (`packages/cli/src/acp/AcpServiceContext.ts`)
- terminal timeout/abort 的完成顺序是 kill → 停止轮询 → 最终读取 → release；提前返回会丢尾部输出并泄漏宿主 terminal (`packages/cli/src/acp/AcpServiceContext.ts`)
- 所有 `sessionUpdate()` 共用一个 `BoundedSerialEgress`；任何 overflow、超时或 connection abort 会中止当前 prompt、user shell 和 side conversation，而不是继续生成未送达内容 (`packages/cli/src/acp/Session.ts`, `git:1af43232`)
- `closeSession` 会以 `discardPendingInput: true` 销毁，连接级 shutdown 默认保留 durable inbox 供下次恢复；这两个关闭语义不能合并 (`packages/cli/src/acp/BladeAgent.ts`, `packages/cli/src/acp/Session.ts`, `git:e260f4bc`)
- `available_commands_update` 必须延迟到 `session/new` 或 `session/load` 响应之后；立即发送会命中尚未准备好的宿主 (`packages/cli/src/acp/Session.ts`)
- ACP 的 `auto-edit` 与 Blade 内部 `autoEdit` 名称不同，模式变更必须先持久化 Session 权限，再发送 `current_mode_update` (`packages/cli/src/acp/BladeAgent.ts`, `packages/cli/src/acp/Session.ts`)
- 模型、reasoning、tier、verbosity 和 communication style 在 prompt 活动期间不可切换；持久化 metadata 失败时模型切换会回滚 Runtime (`packages/cli/src/acp/Session.ts`)
- ACP `!` 命令始终要求 Session terminal 后端，`allowLocalFallback` 为 false；远程宿主 terminal 失败不能偷偷在 Blade 主机执行 (`packages/cli/src/acp/Session.ts`, `packages/cli/src/acp/AcpServiceContext.ts`)

## Architecture
- `BladeAgent` 是连接级 owner，管理多个 `AcpSession` 与 residency；每个 `AcpSession` 再独占 Agent、SessionRuntime、服务上下文和 update queue (`packages/cli/src/acp/BladeAgent.ts`, `packages/cli/src/acp/Session.ts`)
- `AcpServiceContext` 按 session ID 保存 connection、capabilities、cwd、FS 和 Terminal，避免并发 Session 共享“当前”远程服务；无 session 参数的兼容 API 只用于旧调用 (`packages/cli/src/acp/AcpServiceContext.ts`)
- prompt 事件映射为 `agent_message_chunk`、`agent_thought_chunk`、`tool_call(_update)`、`plan` 与 `session_info_update`，所有 update 在 Agent generator 继续前可被 flush 形成背压 (`packages/cli/src/acp/Session.ts`)
- Session setup 同时暴露权限 modes 和模型相关 configOptions；可选项来自该 Session 冻结的 model configuration，不从宿主请求临时拼装 (`packages/cli/src/acp/BladeAgent.ts`, `packages/cli/src/acp/Session.ts`)
- fork 先由 `SessionService` 复制 durable history 与 metadata，再创建独立 AcpSession；父子共享来源 workspace 但拥有不同 Session ID、Runtime 和终端上下文 (`packages/cli/src/acp/BladeAgent.ts`)
- Slash commands 复用核心命令注册表，但 model、permissions、theme、config、exit、ide 等由 ACP 原生 UI/协议接管的命令不会重复暴露 (`packages/cli/src/acp/Session.ts`)

## Decisions
- ACP 能力协商是后端选择，而不是失败回退：未声明能力允许本地实现，已声明能力则认定资源归宿主所有并 fail closed (`packages/cli/src/acp/AcpServiceContext.ts`, `packages/cli/src/acp/AcpFileSystemService.ts`)
- 工具结果优先投影为 ACP 原生 diff content；没有结构化 edit/patch metadata 时才退化为经统一预算裁剪的文本内容 (`packages/cli/src/acp/Session.ts`, `packages/cli/src/tools/display/ToolResultProjector.ts`)
- Session 配置是 durable 状态，`setSessionMode` 和 config option 不只是 UI 通知；宿主看到成功前必须已更新 Runtime 与 Session metadata (`packages/cli/src/acp/Session.ts`)
- 用户问题和 MCP Elicitation 被线性化为 ACP permission 选择流程，以适配宿主交互能力；取消或协议错误统一 fail closed (`packages/cli/src/acp/Session.ts`)

## Patterns
- 创建、fork、load 都先预留 residency，完成 Session 初始化后才 commit；任一步失败都会 cancel reservation 并销毁半初始化 Session (`packages/cli/src/acp/BladeAgent.ts`)
- 所有异步宿主更新先检查 Session 未 destroyed、connection 未 aborted、egress 未 closed；迟到 timer、Bus 回调和 completion 都不得重新激活已释放 Session (`packages/cli/src/acp/Session.ts`)
- 后台子代理完成和 team message 先进入 durable inbox，再在 Session idle 时通过空 prompt 自动续跑；连接关闭时保留该 inbox (`packages/cli/src/acp/Session.ts`)
- `destroy()` 是 single-flight，先关闭 update egress 与订阅，再 cancel 活动工作并等待 completion，最后销毁 Agent、Runtime 和服务上下文，同时保留首个错误 (`packages/cli/src/acp/Session.ts`)
- 图片 prompt 在协议入口同时限制数量、base64 总字节和文本字符/字节；通过校验后才转换成 Blade `UserMessageContent` (`packages/cli/src/acp/Session.ts`)

## Dependencies
- ACP 协议、NDJSON stream、Session capabilities 和 terminal/file RPC 来自 `@agentclientprotocol/sdk`；本地 fallback 仍使用 Blade 的 FileSystemService 与受控进程树 (`packages/cli/src/acp/index.ts`, `packages/cli/src/acp/AcpServiceContext.ts`)
