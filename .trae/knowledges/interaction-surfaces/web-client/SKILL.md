---
name: knowledge-interaction-surfaces-web-client
description: >
  覆盖 Blade React Web 的启动恢复、Session/任务 Zustand 投影、SSE 重连、聊天输入、
  多项目导航、布局、预览、Browser 面板与终端。进入时机：修改 Web 消息流、Session
  切换、草稿、错误恢复、Sidebar/Kanban、全屏预览、文件/Browser 活动或前端 API。
  不包含：Hono 路由与服务端 run 所有权（见 ../hono-server-api-and-streaming/）、
  Browser 自动化内核（见 ../../tool-and-automation-platform/browser-automation/）。
  关键词：useSessionStore, sessionService, EventSource, createEventDispatcher,
  ChatInput, Layout, FilePreview, BrowserPanel, SessionRef。
---

## Module Structure

Web Client 将 HTTP 快照、单 Session SSE 与全局任务 SSE 折叠为浏览器状态，并以复合
SessionRef 驱动聊天、看板、Sidebar、预览和终端；它不直接执行 Agent。

### Directory Layout
- `packages/cli/web/src/App.tsx` — URL/本地状态恢复、全局订阅和主视图选择
- `packages/cli/web/src/services/` — HTTP、Session SSE、全局 SSE 与 Browser API 客户端
- `packages/cli/web/src/store/session/` — Session、消息、流式事件、任务与 UI slices
- `packages/cli/web/src/components/chat/` — 对话时间线、输入、交互、Goal、Team 与状态
- `packages/cli/web/src/components/layout/` — Sidebar、导航、响应式壳层与资源入口
- `packages/cli/web/src/components/tasks/` and `packages/cli/web/src/components/kanban/` — 任务创建、切换与多项目看板
- `packages/cli/web/src/components/preview/` — diff、文件、日志和 Browser 预览
- `packages/cli/web/src/components/terminal/` — WebSocket PTY 面板
- `packages/cli/web/src/lib/` — 草稿、Session 导航、身份、附件和快捷键辅助

### Key Entry Points
- `App` in `packages/cli/web/src/App.tsx` — 解析导航意图并选择临时任务、聊天或看板
- `sessionService.openEventSubscription()` in `packages/cli/web/src/services/sessionService.ts` — 单 Session SSE 与 durable cursor
- `createSessionSlice()` in `packages/cli/web/src/store/session/slices/sessionSlice.ts` — Session 导航、发送、恢复和任务动作
- `createEventDispatcher()` in `packages/cli/web/src/store/session/handlers/eventHandlers.ts` — SSE 到 Store/Browser 活动的分发
- `Layout` in `packages/cli/web/src/components/layout/Layout.tsx` — Sidebar、工作区、预览与终端组合
- `ChatInput` in `packages/cli/web/src/components/chat/ChatInput.tsx` — Session 级输入、草稿和能力选择

## Gotchas
- Web 中 Session 身份必须始终是 `{sessionId, projectPath}`；历史上只比 session ID 会让跨项目同名 Session 的消息、错误、预览和任务状态串线 (`packages/cli/web/src/store/session/sessionIdentity.ts`, `git:d20b6ed5`)
- `selectSession()` 必须先打开并缓冲新 SSE，再并行拉取消息/Goal/Session/Team 快照，最后原子提交身份并回放缓冲事件；先替换 Store 再订阅会产生 snapshot/live 空窗 (`packages/cli/web/src/store/session/slices/sessionSlice.ts`, `git:121ea8fc`)
- 新订阅准备失败时旧订阅必须继续存活；`replaceEventSubscription()` 只能在新连接 ready 后关闭旧连接 (`packages/cli/web/src/store/session/slices/streamingSlice.ts`, `git:b3ffab60`)
- `ChatView` 不应在 React effect cleanup 中取消 Store 拥有的 SSE；StrictMode 会重放 effect，组件级 cleanup 曾导致激活后连接被意外关闭 (`packages/cli/web/src/components/chat/ChatView.tsx`, `git:01505f04`)
- 活动 run 的 SSE 不在线时 Composer 必须禁用 steering；HTTP 仍可接收请求不代表客户端能安全观察确认、终态或 follow-up (`packages/cli/web/src/components/chat/ChatView.tsx`)
- 所有终态事件和 `tool.start` 前必须排空 80ms delta 缓冲；否则 prose/reasoning 可能在工具卡或完成状态之后写入 (`packages/cli/web/src/store/session/handlers/eventHandlers.ts`, `packages/cli/web/src/store/session/handlers/streamingBuffer.ts`)
- `session.completed`、`session.error`、idle status 与 abort 会触发权威消息重同步；只依赖 live delta 无法覆盖断线期间的 committed 结果或恢复生成的消息 (`packages/cli/web/src/store/session/handlers/eventHandlers.ts`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`)
- 显式 URL 中的 Session 是权威意图：目标缺失或不可用时必须停在临时页面并保留导航错误，不能静默打开 localStorage 中另一个 Session (`packages/cli/web/src/store/session/sessionNavigation.ts`)
- Composer 草稿按复合 SessionRef 分区；文本与 output schema 写入 sessionStorage，图片只在内存 Map 保存，浏览器刷新后不会恢复图片附件 (`packages/cli/web/src/components/chat/ChatView.tsx`, `packages/cli/web/src/lib/composerDraft.ts`)
- 发送成功后才清草稿；请求拒绝时 Store 删除 optimistic user message，而 ChatInput 保留输入供重试，不能在点击发送时先清空 (`packages/cli/web/src/components/chat/ChatInput.tsx`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`)
- 模型、reasoning、service tier、verbosity 与 permission mode 在活动 run 中被冻结；Composer 可以显示选择器，但发送 steering 时不会携带这些切换，Server 也会拒绝并发切换 (`packages/cli/web/src/components/chat/ChatInput.tsx`, `packages/cli/web/src/store/session/slices/sessionSlice.ts`)
- FilePreview 的请求必须同时校验 request generation 和当前 SessionRef；仅比较路径或 URL 会让 A→B→A 的旧响应覆盖新 A 状态 (`packages/cli/web/src/components/preview/FilePreview.tsx`)
- worktree Task 交付后文件树浏览 source project，但 durable diff 仍从 Task Session artifact 读取；discard 后则明确隐藏所有旧消息 diff (`packages/cli/web/src/components/preview/FilePreview.tsx`)
- Browser tab 使用 `forceMount` 保留 iframe/控制状态；切换到 Files/Logs 时不能卸载 Browser 会话 (`packages/cli/web/src/components/preview/FilePreview.tsx`)
- 全屏预览仍保留同一个 Chat Composer 和状态投影，只把工作区内容置于覆盖层后；不要为全屏模式创建第二套 ChatView/Input (`packages/cli/web/src/components/layout/Layout.tsx`, `packages/cli/web/src/components/chat/ChatView.tsx`, `git:3b786d37`)

## Architecture
- 启动时全局任务 SSE、Session catalog、设置、模型和工作区信息并行加载；没有显式目标时先进入临时 Session，避免阻塞首屏等待完整 catalog (`packages/cli/web/src/App.tsx`)
- Store 由 Session、TaskList、Message、Streaming 和 UI slices 组成；Session slice 负责身份/命令，event dispatcher 负责事件归约，组件只读取投影 (`packages/cli/web/src/store/session/index.ts`)
- Session SSE 使用 committed `seq` 维护内存游标并指数退避重连；connected 帧必须匹配精确 SessionRef 才算 ready，heartbeat 只更新活性 (`packages/cli/web/src/services/sessionService.ts`)
- 高频 content、thinking 和 subagent delta 按 channel 合并；工具边界会把内容从 before 切到 after，使同一个 assistant 时间线保持正文、工具、后续正文的顺序 (`packages/cli/web/src/store/session/handlers/eventHandlers.ts`)
- 全局任务流单独驱动 Sidebar/Kanban 和 unread attention，不依赖当前打开的 Session；单 Session 流只处理当前精确 ref (`packages/cli/web/src/store/session/slices/taskListSlice.ts`, `packages/cli/web/src/store/session/handlers/eventHandlers.ts`)
- Preview 同时支持 message 内嵌 diff 与 durable Task artifact；有 durable artifact 预期时失败会显示错误而不会退回可能过期的 message diff (`packages/cli/web/src/components/preview/FilePreview.tsx`)
- Agent Browser 活动只从不带 seq 的 live tool start/result 投影到 BrowserActivityStore，并自动打开 Browser tab；历史 committed 工具事件不能伪装成当前活动 (`packages/cli/web/src/store/session/handlers/eventHandlers.ts`, `packages/cli/web/src/store/BrowserActivityStore.ts`, `git:ed9505d7`)

## Decisions
- Web 使用共享 TypeBox API schema 的 Vite alias，而不复制请求/事件类型；Vite 还把巨大的 event handler 单独分 chunk 以控制首屏 bundle (`packages/cli/web/vite.config.ts`)
- 导航 URL 同时携带展示 project 与 Session execution workspace；worktree Session 两者不同时使用独立 `workspace` 参数，分享链接仍能精确恢复 (`packages/cli/web/src/store/session/sessionNavigation.ts`)
- Web 权限模式由当前 Session metadata 驱动，新临时任务重置为 `autoEdit`，避免从刚访问的 YOLO Session 泄漏到下一任务 (`packages/cli/web/src/store/session/slices/sessionSlice.ts`, `packages/cli/web/src/store/ConfigStore.ts`)
- 输入能力控件按当前模型 catalog 动态显示，communication style 例外地是全局跨 Session 偏好；不要把它误做成 Composer 私有 override (`packages/cli/web/src/components/chat/ChatInput.tsx`, `packages/cli/web/src/store/SettingsStore.ts`)

## Patterns
- 每次导航、fork、异步预览和 catalog 加载都持有 generation；结果返回时同时验证 generation 与精确 ref，迟到成功和迟到错误都静默丢弃 (`packages/cli/web/src/store/session/slices/sessionSlice.ts`, `packages/cli/web/src/components/preview/FilePreview.tsx`)
- optimistic user message 仅覆盖提交等待窗口，服务端 `message.created` 会按身份替换；提交失败则移除 optimistic 项并设置带 SessionRef 的 errorContext (`packages/cli/web/src/store/session/slices/sessionSlice.ts`, `packages/cli/web/src/store/session/slices/messageSlice.ts`)
- 错误 UI 按 navigation、submission、execution、task_action 分类；另一个 Session 的 task action 错误不得出现在当前 ChatView (`packages/cli/web/src/components/chat/ChatView.tsx`)
- 响应式 Sidebar 与 Preview 在窄屏作为 focus-contained modal，并把所有背景区域设为 inert；关闭后恢复触发按钮焦点 (`packages/cli/web/src/components/layout/Layout.tsx`, `packages/cli/web/src/components/preview/FilePreview.tsx`)
- 本地持久化均 fail open：导航、草稿、Sidebar 模式和 Preview 宽度在 storage 被禁用时仍保留内存行为 (`packages/cli/web/src/lib/composerDraft.ts`, `packages/cli/web/src/store/session/sessionNavigation.ts`, `packages/cli/web/src/store/AppStore.ts`)

## Dependencies
- Web 使用 React 19、Zustand、Vite、Radix primitives、Monaco 与 xterm；运行时 API 路径由 Vite dev proxy 或 BladeServer 同源静态托管提供 (`packages/cli/web/package.json`, `packages/cli/web/vite.config.ts`)
