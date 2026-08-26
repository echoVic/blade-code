---
name: knowledge-interaction-surfaces-hono-server-api-and-streaming
description: >
  覆盖 Blade Hono 服务的路由装配、Session/Task 控制器、SSE replay/live 切换、
  WebSocket 终端、静态资源、认证、错误映射与资源关闭。进入时机：新增 HTTP API、
  修改 Web 事件协议、处理同名 Session、调试断线重连、服务容量或 shutdown。 不包含：
  浏览器端 Zustand 投影（见 ../web-client/）、SessionEventLog 内部存储（见
  ../../session-state-and-context/）。关键词：BladeServer, createSessionRouteController,
  OrderedSseEgress, Bus, Last-Event-ID, SessionRef, Hono, SSE, terminal WebSocket。
---

## Module Structure

Server 是 Web 与自动化客户端的协议适配层：它拥有活动 run、Runtime residency、SSE
订阅者和 Web Browser Session，但 durable transcript 与任务事实仍由 Session 服务持有。

### Directory Layout
- `packages/cli/src/server/server.ts` — Hono 装配、认证/CORS、静态资源和网络生命周期
- `packages/cli/src/server/routes/session.ts` — Session、run、消息、交互和 SSE 主控制器
- `packages/cli/src/server/routes/task.ts` — 顶层任务提交、重试、diff 与交付 API
- `packages/cli/src/server/routes/events.ts` — 跨 Session 的看板安全全局事件流
- `packages/cli/src/server/routes/terminal.ts` — Bun/Node WebSocket PTY 适配
- `packages/cli/src/server/routes/` — 配置、Provider、MCP、插件、Hooks 等管理 API
- `packages/cli/src/server/OrderedSseEgress.ts` — replay/live 原子切换与有界写入
- `packages/cli/src/server/sessionRef.ts` — Session 复合身份规范化
- `packages/cli/src/server/WebBrowserSessionRegistry.ts` — Web 专用 Browser Runtime 所有权

### Key Entry Points
- `BladeServer.listenAsync()` in `packages/cli/src/server/server.ts` — 启动 Bun 或 Node 服务
- `createSessionRouteController()` in `packages/cli/src/server/routes/session.ts` — 创建路由与 Runtime 管理器
- `dispatchTask()` on `SessionRouteController` — Web、定时任务共用的任务派发入口
- `OrderedSseEgress.finishInitialization()` in `packages/cli/src/server/OrderedSseEgress.ts` — replay 到 live 的切换点
- `resolveSessionRef()` in `packages/cli/src/server/routes/session.ts` — 解析精确 Session 所属工作区

## Gotchas
- `sessionId` 不是 Server 内的完整身份；路由、活动 run、Runtime、锁和 Browser Registry 必须使用规范化的 `projectPath + sessionId`，同名多工作区且未给路径时应返回 409 而不是猜测 (`packages/cli/src/server/sessionRef.ts`, `packages/cli/src/server/routes/session.ts`)
- Session SSE 初始化必须先订阅 Bus 并缓冲 live，再写 connected、按 JSONL `seq` 回放、去重排序后切到 live；先回放再订阅会产生不可修复的事件空窗 (`packages/cli/src/server/routes/session.ts`, `packages/cli/src/server/OrderedSseEgress.ts`, `git:121ea8fc`)
- 只有 committed event 能携带 SSE `id`；ephemeral delta 在 replay 窗口直接丢弃，不能推进 `Last-Event-ID` (`packages/cli/src/server/bus.ts`, `packages/cli/src/server/OrderedSseEgress.ts`)
- `EventSource` 首次连接不能自定义 `Last-Event-ID` header，因此 Server 同时接受 `lastEventId` query；删除 query 支持会破坏页面刷新后的 durable resume (`packages/cli/src/server/routes/session.ts`)
- Session SSE 与 `/events` 全局 SSE 不可互换：全局流只投影白名单化的看板字段，明确排除 prompt 和私有执行细节 (`packages/cli/src/server/routes/events.ts`)
- 慢 SSE subscriber 的 overflow、写超时或 sequence regression 只终止该 subscriber，不能取消 server-owned Agent run 或影响其他订阅者 (`packages/cli/src/server/OrderedSseEgress.ts`, `docs/reference/surface-egress.md`)
- 活动 run 收到新 message 时走 durable steering/follow-up，不启动第二个 run；同时切换模型、权限、reasoning、tier、verbosity、style 或 output schema会返回冲突 (`packages/cli/src/server/routes/session.ts`)
- pending permission 既可能在内存 run 中，也可能只剩磁盘交互记录；响应路由必须先匹配精确 run，再通过 `SessionInteractionService.respondAndRecover()` 冷恢复 (`packages/cli/src/server/routes/permission.ts`, `packages/cli/src/server/routes/session.ts`)
- API 未设置 `BLADE_SERVER_PASSWORD` 时整体无认证；启用 Basic Auth 后根页面与静态资源仍公开，只有 API 路径受保护 (`packages/cli/src/server/server.ts`, `packages/cli/src/commands/serve.ts`)
- CORS 默认只放行 localhost、127.0.0.1 和 Tauri origin，额外来源必须通过 `--cors`；监听 `0.0.0.0` 不会自动放宽 CORS (`packages/cli/src/server/server.ts`, `packages/cli/src/cli/network.ts`)
- Node 与 Bun 的 PTY/WebSocket 适配不同，但最后一个终端 subscriber 断开时都会杀掉 PTY；Terminal 面板重连不会保留无人订阅的进程 (`packages/cli/src/server/routes/terminal.ts`)
- 删除 Session 时还要释放 Web Browser Runtime、活动 review/run、Runtime residency 和任务 worktree；只删 transcript 会留下进程与浏览器资源 (`packages/cli/src/server/routes/session.ts`, `packages/cli/src/server/WebBrowserSessionRegistry.ts`)

## Architecture
- `server.ts` 创建一个 SessionRouteController，并把同一 controller 注入 TaskRoutes 和 TaskScheduler，使 HTTP 手工任务、Web 操作和 schedule 复用相同准入与恢复逻辑 (`packages/cli/src/server/server.ts`)
- SessionController 分开管理 hydrated Session、active/recent run、Runtime initialization/disposal 与 residency lease；并发请求通过按 SessionRef 分片的 mutex 串行化消息和交付 (`packages/cli/src/server/routes/session.ts`)
- Runtime residency 只缓存可驱逐的 idle Runtime；active turn、pending interaction 或其他 pin 会阻止驱逐，容量满时映射为带资源详情的 429 (`packages/cli/src/server/routes/session.ts`, `packages/cli/src/server/error.ts`)
- `Bus` 是进程内扇出，不是持久消息队列；durable replay 始终从 `SessionEventLog` 读取，Bus 只承载当前进程 live 事件 (`packages/cli/src/server/bus.ts`, `packages/cli/src/server/routes/session.ts`)
- BrowserRoutes 在 SessionController 下共享精确 SessionRef 和全局 Browser admission，但 Web 测试浏览器由独立 registry 持有，不复用 Agent 的 browser runtime (`packages/cli/src/server/routes/browser.ts`, `packages/cli/src/server/WebBrowserSessionRegistry.ts`)
- Hono 顶层 `onError` 将容量和已分类 `BladeServerError` 保留为稳定状态码，其余错误收敛为 500 JSON envelope (`packages/cli/src/server/server.ts`, `packages/cli/src/server/error.ts`)

## Decisions
- Server 将 run 生命周期与 HTTP 请求解耦，请求返回 202 后由 Runtime 持续执行；SSE viewer 断开不等于取消任务，显式 abort 路由才改变 run (`packages/cli/src/server/routes/session.ts`)
- 静态资源使用内存原文/压缩缓存，Brotli 与 gzip 按 q 值选择，hash asset 长缓存而 `index.html` no-cache，以支持单进程直接托管 Web build (`packages/cli/src/server/server.ts`)
- 全局事件流采用字段级投影而不是透传 BusEvent，避免多项目任务看板获得 Session prompt、工具参数或私有结果 (`packages/cli/src/server/routes/events.ts`)
- Bun `listen()` 是同步专用入口，跨运行时命令使用 `listenAsync()`；Node fallback 只在异步入口组装 HTTP 与 `ws` upgrade (`packages/cli/src/server/server.ts`)

## Patterns
- 每个写 API 先解析 TypeBox schema，再解析精确 SessionRef，再进入 keyed lock/Runtime lease；新增写端点应保持该顺序以避免校验失败后占用运行资源 (`packages/cli/src/server/routes/session.ts`, `packages/cli/src/server/routes/task.ts`)
- Session run 的终态顺序是刷新 durable metadata、发送 `session.completed`/`session.error`、发送 idle/error status，最后释放 admission、Agent 和 Runtime lease (`packages/cli/src/server/routes/session.ts`)
- Server 输出的工具 metadata 经过 allowlist 投影，展示正文再按表面字符预算裁剪；Browser 诊断与 shell background 元数据另有严格字段校验 (`packages/cli/src/server/routes/session.ts`, `packages/cli/src/tools/display/ToolResultProjector.ts`)
- 服务关闭是幂等 single-flight：停止网络接入、关闭 SessionController、停止 scheduler/GC、重置 workspace 资源，并保留首个清理错误 (`packages/cli/src/server/server.ts`)
- Session Browser Registry 在从 Map 删除引用后再 dispose，批量关闭使用 `allSettled` 回收全部 Runtime 后才抛首个错误 (`packages/cli/src/server/WebBrowserSessionRegistry.ts`)

## Dependencies
- HTTP/SSE 使用 Hono，终端 WebSocket 使用 Bun WebSocket 或 `ws` + Node upgrade，PTY 使用 `bun-pty` 或 `node-pty`；跨运行时修改必须验证两条启动路径 (`packages/cli/src/server/server.ts`, `packages/cli/src/server/routes/terminal.ts`)
