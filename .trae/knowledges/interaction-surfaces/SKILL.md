---
name: knowledge-interaction-surfaces
description: >
  覆盖 Blade 的 CLI、TUI、Hono Server、Web、ACP 与 VS Code 六种交互表面，以及它们对同一
  Agent、Session 和事件事实的不同投影方式。进入时机：修改启动分流、跨端事件、用户输入、
  会话导航、输出背压、宿主能力或任一表面的生命周期。 不包含：Agent 决策语义（见
  ../agent-execution-and-orchestration/）、会话持久化内部实现（见
  ../session-state-and-context/）、工具与 Browser 内核运行机制（见
  ../tool-and-automation-platform/）。关键词：blade.tsx, headless, Ink, Hono, SSE,
  React Web, ACP, VS Code, SessionRef, surface projection。
---

## Module Structure

该域是 Blade 的运行边界层：各表面负责接收用户或宿主输入、建立 Session 运行环境并投影
统一事件，但不拥有 Agent 决策或 durable transcript 的权威状态。

### Directory Layout
- `packages/cli/src/blade.tsx` — 统一进程入口与运行表面分流
- `packages/cli/src/cli/` — 全局参数、设置覆盖和 yargs 中间件
- `packages/cli/src/commands/` — Headless、Print、Serve、Web 与管理命令
- `packages/cli/src/ui/` — React + Ink 终端交互与本地事件投影
- `packages/cli/src/server/` — Hono HTTP、SSE、WebSocket 终端和服务端资源所有权
- `packages/cli/web/src/` — React Web、Zustand 投影、导航和预览工作区
- `packages/cli/src/acp/` — ACP Agent、Session、远程文件系统与终端能力适配
- `packages/vscode/src/` — VS Code WebSocket 桥

### Key Entry Points
- `main()` in `packages/cli/src/blade.tsx` — 按 Headless、Print、ACP、子命令和默认 TUI 的优先级启动表面
- `AppWrapper` in `packages/cli/src/ui/App.tsx` — TUI 的信任判断、资源初始化和主界面入口
- `BladeServer.listenAsync()` in `packages/cli/src/server/server.ts` — Web/API 服务启动与关闭入口
- `App` in `packages/cli/web/src/App.tsx` — Web 导航恢复、任务流订阅和页面分流入口
- `runAcpIntegration()` in `packages/cli/src/acp/index.ts` — ACP stdio/NDJSON 连接入口
- `activate()` in `packages/vscode/src/extension.ts` — VS Code 桥激活入口

## Gotchas
- 各表面只是同一 Runtime 事实的投影，不能把 TUI Store、Web Zustand、ACP update 或 Headless 输出当作持久化权威；恢复必须重新读取 Session 数据或 committed event (`packages/cli/src/store/slices/sessionSlice.ts`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`, `packages/cli/src/acp/Session.ts`)
- 远端表面中的 Session 身份是 `projectPath + sessionId`，只按 session ID 过滤或缓存会把不同工作区的同名 Session 串在一起 (`packages/cli/src/server/sessionRef.ts`, `packages/cli/web/src/store/session/sessionIdentity.ts`)
- committed event 带单调 `seq` 并可重放，流式 delta、heartbeat 和瞬时工具活动不带 `seq`；让 ephemeral 事件推进恢复游标会造成重连丢事件 (`packages/cli/src/server/bus.ts`, `packages/cli/src/server/routes/session.ts`, `git:c776d496`)
- Headless、Web SSE 与 ACP 都必须有界且串行输出，但失败语义不同：Headless 取消当前运行，Web 逐出单个订阅者，ACP 中止当前 Session 操作；不能用一个表面的断连策略推断另一个表面 (`packages/cli/src/commands/HeadlessOutputEgress.ts`, `packages/cli/src/server/OrderedSseEgress.ts`, `packages/cli/src/acp/Session.ts`)
- 工具结果先经过统一展示投影和表面字符预算，再映射成卡片、JSONL、SSE 或 ACP content；直接发送原始工具输出会绕过敏感元数据清理与有界输出规则 (`packages/cli/src/tools/display/ToolResultProjector.ts`, `packages/cli/src/server/routes/session.ts`)
- `! <command>` 在各表面共享 Session-owned 持久语义，但终端后端由表面决定；尤其 ACP 是否远程执行取决于宿主声明的 terminal capability (`packages/cli/src/services/UserShellCommandService.ts`, `packages/cli/src/acp/AcpServiceContext.ts`)

## Architecture
- CLI/TUI 直接在当前进程消费 `Agent.chatStream()`，Web 通过 Hono + SSE 控制 server-owned run，ACP 将同一 LoopEvent 映射为协议 update，VS Code 则是独立的轻量 WebSocket 编辑器桥 (`packages/cli/src/commands/headless.ts`, `packages/cli/src/server/routes/session.ts`, `packages/cli/src/acp/Session.ts`, `packages/vscode/src/extension.ts`)
- 每个长生命周期表面都把 `SessionRuntime` 作为资源所有权边界：TUI Hook 持有一个活动 Runtime，Server 与 ACP 再用 residency 管理多个 Runtime；视图组件不能自行复制 Runtime 生命周期 (`packages/cli/src/ui/hooks/useAgent.ts`, `packages/cli/src/server/routes/session.ts`, `packages/cli/src/acp/BladeAgent.ts`)
- Web 的单 Session SSE 与全局任务 SSE 是两条不同通道：前者承载完整会话投影和 durable replay，后者只发布看板安全元数据，避免跨 Session 泄露 prompt 与执行细节 (`packages/cli/src/server/routes/session.ts`, `packages/cli/src/server/routes/events.ts`)
- TUI 是本地 Ink 投影，不经过远端 egress 队列；远端 viewer 变慢不会阻塞 TUI，而 raw PTY 自身的背压由终端进程处理 (`docs/reference/surface-egress.md`)

## Decisions
- 统一事件溯源改造后，CLI、Web 与 ACP 都围绕 committed/ephemeral 两层事件工作，新增跨端状态应先定义 canonical Runtime 事件，再分别补投影，而不是在各 UI 自建事实 (`packages/cli/src/context/events/SessionEventLog.ts`, `git:c776d496`)
- 运行表面统一采用有界串行 egress，是为了让慢消费者无法造成无界内存，同时保留 canonical Session 供 reload/resume；普通事件不会为保活而静默丢弃 (`docs/reference/surface-egress.md`, `git:1af43232`)
- Web Server 与 Web Client 通过 `packages/cli/src/api/` 的 TypeBox schema 共享契约，ACP 和 Headless 保留各自外部协议形状；不要强行把 ACP 或 JSONL wire 格式复用为 HTTP schema (`packages/cli/src/api/schemas.ts`, `packages/cli/src/commands/headlessEvents.ts`)

## Patterns
- 终态投影采用“先排空增量，再发布终态，再按需重读权威历史”的顺序，避免最后一个 delta 被异步缓冲器留在终态之后 (`packages/cli/web/src/store/session/handlers/eventHandlers.ts`, `packages/cli/src/ui/utils/loopEventHandler.ts`)
- 表面切换或 Session 替换都先停止旧输入/订阅并释放旧 Runtime，再提交新身份；迟到结果必须以 generation 或精确 SessionRef 丢弃 (`packages/cli/src/ui/utils/sessionActivation.ts`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`, `packages/cli/src/acp/BladeAgent.ts`)
- 用户可见的 Provider、Goal、Subagent、Team 和 Tool 状态都来自事件映射；增加新的 LoopEvent 时应检查 Headless exhaustive switch、TUI handler、Server emitter、Web dispatcher 与 ACP update (`packages/cli/src/commands/headless.ts`, `packages/cli/src/ui/utils/loopEventHandler.ts`, `packages/cli/src/server/routes/session.ts`, `packages/cli/web/src/store/session/handlers/eventHandlers.ts`, `packages/cli/src/acp/Session.ts`)

## Child Knowledge Nodes
- `./cli-bootstrap-headless-and-print/SKILL.md` — 进入时机：修改 CLI 启动优先级、全局参数、Headless/Print 输入输出、信号处理或管理子命令
- `./terminal-ui/SKILL.md` — 进入时机：修改 Ink 输入、消息渲染、确认流程、Session 切换、流式缓冲或 TUI Runtime 生命周期
- `./hono-server-api-and-streaming/SKILL.md` — 进入时机：修改 Hono 路由、Session/Task API、SSE replay、WebSocket 终端、认证或服务关闭
- `./web-client/SKILL.md` — 进入时机：修改 React Web、Zustand Session 投影、SSE 重连、导航、草稿、布局、预览或任务看板
- `./acp-host-integration/SKILL.md` — 进入时机：修改 ACP 能力协商、Session load/fork、远程 FS/Terminal、权限、流式 update 或宿主展示
- `./vscode-bridge/SKILL.md` — 进入时机：修改 VS Code 扩展激活、端口发现、WebSocket RPC、编辑器/诊断/Diff 操作或扩展打包
