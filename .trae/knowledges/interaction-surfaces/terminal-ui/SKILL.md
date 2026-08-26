---
name: knowledge-interaction-surfaces-terminal-ui
description: >
  覆盖 Blade React + Ink TUI 的初始化、输入协议、消息与工具渲染、确认队列、Session
  切换、流式缓冲和 Runtime 清理。进入时机：修改终端键盘行为、粘贴、Ctrl+C、审批与
  问答、流式输出、Static 布局、会话恢复或 slash command 展示。 不包含：Headless/Print
  输出（见 ../cli-bootstrap-headless-and-print/）、Web React 状态（见 ../web-client/）。
  关键词：AppWrapper, BladeInterface, MessageArea, useCommandHandler, useAgent,
  useConfirmation, parseTerminalInput, Static, rawStreamRenderer。
---

## Module Structure

TUI 以单个 vanilla Zustand Store 投影当前 Session，React Hook 只持有活动 Agent/Runtime
和输入交互生命周期；durable 消息、权限模式与恢复数据仍由 Session 服务管理。

### Directory Layout
- `packages/cli/src/ui/App.tsx` — 版本提示、Workspace Trust、资源与 Hook 初始化
- `packages/cli/src/ui/components/BladeInterface.tsx` — 主界面、阻塞弹窗与 Session 启动路由
- `packages/cli/src/ui/components/MessageArea.tsx` — 单 Static 根、流式块和 raw tail 渲染
- `packages/cli/src/ui/components/` — 输入、确认、问答、状态和工具展示组件
- `packages/cli/src/ui/hooks/` — Agent、命令、输入、确认、Ctrl+C 与缓冲生命周期
- `packages/cli/src/ui/input/terminalInput.ts` — bracketed paste 与终端控制序列解析
- `packages/cli/src/ui/utils/` — LoopEvent 投影、Session 激活、Markdown 和工具格式化
- `packages/cli/src/store/` — React 与非 React 代码共享的当前进程状态
- `packages/cli/src/slash-commands/` — TUI 内置与自定义命令路由

### Key Entry Points
- `AppWrapper` in `packages/cli/src/ui/App.tsx` — 完成信任判断后挂载主界面
- `BladeInterface` in `packages/cli/src/ui/components/BladeInterface.tsx` — 组合输入、弹窗、消息与状态区
- `useCommandHandler()` in `packages/cli/src/ui/hooks/useCommandHandler.ts` — 单轮命令、取消和恢复编排
- `useAgent()` in `packages/cli/src/ui/hooks/useAgent.ts` — Agent/SessionRuntime 的唯一 React 所有者
- `createLoopEventHandler()` in `packages/cli/src/ui/utils/loopEventHandler.ts` — LoopEvent 到 TUI Store 的投影

## Gotchas
- 取消顺序不可交换：先 `dismissAll()` 释放阻塞审批，再排空流式缓冲，再 abort，最后 finalize；先 abort 会把审批拒绝误判为普通 permission denial，晚到 `stream_end` 还可能重复提交 (`packages/cli/src/ui/hooks/useCommandHandler.ts`, `packages/cli/src/ui/hooks/useConfirmation.ts`)
- `createAbortController()` 会主动中止并替换已有 controller；命令下层必须复用外层 controller，否则 finally 的所有权检查失败并让 `isProcessing` 永久卡住 (`packages/cli/src/ui/hooks/useCommandHandler.ts`, `packages/cli/src/store/slices/commandSlice.ts`)
- `MessageArea` 只能有一个 Ink `Static` 根；条件挂载第二个 Static 曾让 Ink 保留已释放 Yoga 节点并在后续 commit 崩溃 (`packages/cli/src/ui/components/MessageArea.tsx`, `docs/testing/tui-single-static-root-ownership-evidence.md`, `git:c68977b7`)
- 高频 Markdown tail 绕过 React 直接写 stdout；在 Static 增长、finalize、清屏、resize 或历史展开前必须先清理 raw renderer，否则终端会残留或错位 (`packages/cli/src/ui/components/MessageArea.tsx`, `packages/cli/src/ui/utils/rawStreamRenderer.ts`)
- `clearCount` 是 Static 的唯一强制重挂边界，finalize 时还必须先 `eraseScreen + cursorTo(0,0)`；仅清屏不归位会在顶部留下大段空白 (`packages/cli/src/ui/components/MessageArea.tsx`)
- 一次 stdin 回调可能是完整 IME 文本或批量自动化输入，不能逐字符假设；bracketed paste marker 还可能被 Ink 去掉 ESC 或跨 chunk 到达 (`packages/cli/src/ui/input/terminalInput.ts`, `docs/reference/tui-terminal-input.md`)
- 未闭合 paste 会留在 parser buffer，超过消息字符预算后一直丢弃到 end marker；不要把半段 paste 当普通输入提交 (`packages/cli/src/ui/input/terminalInput.ts`)
- 第一次 Ctrl+C 在执行中只取消任务并显示二次退出提示，3 秒内第二次才走 GracefulShutdown；直接恢复 Ink 的默认 `exitOnCtrlC` 会跳过资源释放 (`packages/cli/src/ui/hooks/useCtrlCHandler.ts`, `packages/cli/src/blade.tsx`)
- Session 激活必须先完成 fork/load 和 UI-safe 转换，再 `cleanupAgent()`，最后一次性恢复新 Store；清理失败时不能提前切换界面身份 (`packages/cli/src/ui/utils/sessionActivation.ts`)
- fork 提示是 UI-only assistant message，不进入恢复的 model context；把 visible messages 重建为上下文会污染后续模型输入 (`packages/cli/src/ui/utils/sessionActivation.ts`, `packages/cli/src/ui/utils/sessionContext.ts`)
- 阻塞弹窗通过 `display="none"` 隐藏主界面而不卸载，目的是保留 Static 和输入状态；改成条件卸载会重复打印历史并丢失输入组件状态 (`packages/cli/src/ui/components/BladeInterface.tsx`)

## Architecture
- `AppWrapper` 先处理版本提示和 Workspace Trust，再解析可信资源与 Hooks；选择“安全继续”只跳过信任授予，不跳过应用初始化 (`packages/cli/src/ui/App.tsx`)
- `useAgent` 同时拥有 Agent 和 SessionRuntime 引用；Session ID 或 workspace 改变时先幂等销毁旧 Agent，再 dispose 整个 Runtime 边界 (`packages/cli/src/ui/hooks/useAgent.ts`, `git:959149a8`)
- TUI Store 不做持久化：会话写入 JSONL、配置写入 ConfigService；Store 只保存当前进程投影和渲染缓冲 (`packages/cli/src/store/vanilla.ts`)
- `createLoopEventHandler` 为每轮创建闭包，以 `streamFinalized` 隔离 abort、fallback 和正常 `stream_end`；跨轮复用 handler 会让上一轮终态污染下一轮 (`packages/cli/src/ui/utils/loopEventHandler.ts`)
- 流式内容有 Hook 层批缓冲、Store 外模块级 chunks、Markdown 增量缓存和 raw tail 四层状态，正常结束与取消都必须按所有权逐层排空或丢弃 (`packages/cli/src/ui/hooks/useStreamingBuffer.ts`, `packages/cli/src/store/slices/sessionSlice.ts`, `packages/cli/src/ui/utils/markdownIncremental.ts`)
- Confirmation Hook 把请求串成单活动项队列，并为每项绑定 AbortSignal；工具执行并不直接依赖某个具体 Ink 组件 (`packages/cli/src/ui/hooks/useConfirmation.ts`)

## Decisions
- React 与 Agent/工具共享 vanilla Zustand 实例，但只暴露 actions 和 selectors，以避免非 React 路径另建状态源 (`packages/cli/src/store/vanilla.ts`, `packages/cli/src/store/selectors/index.ts`)
- 已完成历史使用 Ink Static，最高频 tail 使用 raw renderer，是为兼顾原生 scrollback 与流式性能；这两条路径通过 message ID 和 finalize 标记去重 (`packages/cli/src/ui/components/MessageArea.tsx`)
- TUI 启用 bracketed paste 并显式关闭 focus reporting，退出时重复恢复终端模式，避免异常关闭把宿主 shell 留在特殊输入状态 (`packages/cli/src/ui/hooks/useTerminalInputModes.ts`, `docs/reference/tui-terminal-input.md`)

## Patterns
- Session 级模型、reasoning、service tier、verbosity 和 communication style 都先刷新 Runtime、再持久化 metadata；持久化失败会回滚 Runtime，避免界面与重启状态分叉 (`packages/cli/src/ui/hooks/useAgent.ts`)
- 恢复 Session 时同时保存 UI-safe messages 与原始 model context，后续只把恢复边界后的新 UI 消息追加到原始上下文 (`packages/cli/src/store/slices/sessionSlice.ts`, `packages/cli/src/ui/utils/sessionContext.ts`)
- 用户输入在 slash command、Hook 改写和 Agent 输入之间保留不同表示：Hook 可改写模型输入，但不能回写已经提交的用户可见消息 (`packages/cli/src/ui/hooks/useCommandHandler.ts`)
- 工具进度、Provider 恢复和 MCP 事件通过统一 LoopEvent handler 投影；新增事件必须保持 exhaustive switch，并避免把结构化输出保留工具渲染成普通工具卡 (`packages/cli/src/ui/utils/loopEventHandler.ts`)
- 主题、权限、Session 选择等弹窗共享焦点状态，主输入仅在没有阻塞弹窗时接管键盘；组件自己的 `useInput` 必须检查对应 FocusId (`packages/cli/src/ui/components/BladeInterface.tsx`, `packages/cli/src/ui/components/ConfirmationPrompt.tsx`)

## Dependencies
- TUI 使用 React、Ink、Yoga 与 Zustand；`ink-text-input` 只处理编辑行为，终端 framing 和批量输入由项目自己的 parser 补齐 (`packages/cli/src/ui/components/CustomTextInput.tsx`, `packages/cli/src/ui/input/terminalInput.ts`)
