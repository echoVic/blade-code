---
name: knowledge-browser-automation
description: >
  Covers 原生 Playwright Browser Tool、Chromium 进程池、Session Context、页面与 ARIA snapshot/ref 权威、同源安全、诊断/截图和 Web Browser 面板投影。
  Navigate when: 修改 BrowserNavigate/Snapshot/Interact/Wait/Inspect/Page、浏览器安装、跨源阻断、页面并发、截图制品、Agent 浏览器可视化或资源回收。
  Excludes: 被动 WebSearch/WebFetch（见 ../integration-and-workflow-tool-adapters/）、通用工具权限顺序（见 ../tool-execution-pipeline/）。
  Keywords: BrowserProcessPool, SessionBrowserRuntime, BrowserSnapshotAuthority, BrowserSecurity, BrowserNavigate, BrowserInteract, ARIA ref, Chromium, Playwright.
---

## Module Structure

原生 Browser Tool 使用一个惰性进程级 Chromium 池，每个 Session 获取独立临时
`BrowserContext`。Agent 工具和 Web 用户测试浏览器都复用 `SessionBrowserRuntime`
契约，但拥有不同 runtime 实例；Web Preview iframe 仍是独立展示能力。

### Directory Layout
- `packages/cli/src/browser/` — 安装检查、进程池、安全、快照权威、制品和 Session runtime
- `packages/cli/src/tools/builtin/browser/` — 六个 Agent 工具及有界结果封装
- `packages/cli/src/api/browserSchemas.ts` — Web Browser 请求与共享结果类型
- `packages/cli/src/server/routes/browser.ts` — Web 用户测试浏览器 API
- `packages/cli/src/server/WebBrowserSessionRegistry.ts` — Web Session 对应的独立 runtime 注册表
- `packages/cli/web/src/components/preview/` — Preview/Test/External 面板
- `packages/cli/web/src/store/BrowserActivityStore.ts` — Agent Browser tool 活动投影

### Key Entry Points
- `BrowserProcessPool.acquire()` in `packages/cli/src/browser/BrowserProcessPool.ts` — 惰性启动 Chromium 并分配 Context lease
- `SessionBrowserRuntime` in `packages/cli/src/browser/SessionBrowserRuntime.ts` — 导航、观察、交互、等待、诊断与页面生命周期
- `BrowserSnapshotAuthority` in `packages/cli/src/browser/BrowserSnapshotAuthority.ts` — 最新 snapshot/ref 的短期授权
- `createBrowserTools()` in `packages/cli/src/tools/builtin/browser/browserTools.ts` — 将 runtime 暴露为六个 deferred 工具
- `BrowserRoutes()` in `packages/cli/src/server/routes/browser.ts` — Web 测试模式的 HTTP 控制面

## Gotchas
- 六个 Browser 工具都没有 opt-in `isRetrySafe`，即使 Snapshot/Wait/Inspect 是 `ReadOnly` 也默认不可自动重放；浏览器断线、超时或动作结果不确定时必须由 Agent 重新观察后显式决定 (`packages/cli/src/tools/builtin/browser/browserTools.ts`, `packages/cli/src/tools/core/createTool.ts`)
- `BrowserInteract` 每次尝试在 Playwright 动作前就使输入 snapshot 失效，无论动作成功、超时还是部分失败；同一 `snapshotId/ref` 不能用于第二个动作 (`packages/cli/src/browser/SessionBrowserRuntime.ts`, `packages/cli/src/tools/builtin/browser/browserTools.ts`)
- 动作开始后的异常可能返回 `actionApplied='unknown'` 与 `sideEffectsUncertain=true`；此时不能盲目重试提交、点击或输入，必须先获取新快照检查实际页面状态 (`packages/cli/src/browser/types.ts`, `packages/cli/src/browser/SessionBrowserRuntime.ts`)
- `applied_observation_failed` 是动作已完成的成功结果，只代表后续观察失败；把它当作动作失败重试会重复副作用 (`packages/cli/src/browser/types.ts`, `packages/cli/src/tools/builtin/browser/browserTools.ts`)
- `expectedOrigin` 必须使用含有效端口的 canonical origin，例如 HTTPS 默认端口也归一为 `:443`；它必须同时匹配页面授权 origin、当前 origin 和 snapshot origin (`packages/cli/src/browser/BrowserSecurity.ts`, `packages/cli/src/browser/SessionBrowserRuntime.ts`)
- 跨源顶层导航和 popup 在 route 层阻断；同源页面可加载跨源子资源，但跨源或 opaque sandbox iframe 的 ref 不能继承顶层授权 (`packages/cli/src/browser/SessionBrowserRuntime.ts`, `git:7467bfc4`)
- popup 在 Frame 尚不可用时只能通过 opener/referrer 归属；多个候选导致归属不唯一时 fail closed，不能借用同源的另一个页面授权 (`packages/cli/src/browser/SessionBrowserRuntime.ts`, `git:35e51f5a`)
- fill/type 会拒绝密码、OTP、卡号、安全码、token/key 等凭据控件；可访问名称过长或 `aria-labelledby` 名称不可确认时同样按敏感控件拒绝 (`packages/cli/src/browser/BrowserSecurity.ts`, `packages/cli/src/browser/SessionBrowserRuntime.ts`)
- Download 永远取消并使发起交互返回 `browser_download_blocked`；截图才会进入私有 Session artifact store (`packages/cli/src/browser/SessionBrowserRuntime.ts`, `packages/cli/src/browser/BrowserArtifactStore.ts`)
- `BrowserWait` 和 `BrowserInspect` 要求已有页面，断线或 reset 后不能隐式恢复；恢复入口只能是 Navigate、Snapshot 或 Page open (`packages/cli/src/browser/SessionBrowserRuntime.ts`, `docs/superpowers/specs/2026-08-25-native-browser-tool-design.md`)
- Chromium 不会随 npm 安装自动下载；缺失或沙箱启动失败统一返回 `browser_not_installed`，安装必须显式执行 `blade browser install` (`packages/cli/src/browser/BrowserInstallation.ts`, `packages/cli/src/browser/BrowserProcessPool.ts`)
- Agent Browser、Web 用户 Test Browser 与 Preview iframe 相互独立；在一个表面导航不会共享另一个 runtime 的 cookies、页面或 snapshot ID (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/server/WebBrowserSessionRegistry.ts`, `packages/cli/web/src/components/preview/BrowserPreview.tsx`)

## Architecture
- `BrowserProcessPool` 是唯一 Chromium owner，启动 single-flight，最多 8 个 Context；最后一个 lease 释放时立即关闭浏览器，意外 disconnect 递增 generation 并使旧 lease 失效 (`packages/cli/src/browser/BrowserProcessPool.ts`)
- 每个 `SessionBrowserRuntime` 最多 8 页、32 个排队操作，并通过 FIFO gate 串行所有六类操作；工具层的 `parallelism='exclusive'` 与 runtime gate 共同覆盖不同 executor 共享同一 Session runtime 的情况 (`packages/cli/src/browser/BrowserOperationGate.ts`, `packages/cli/src/tools/builtin/browser/browserTools.ts`)
- snapshot authority 绑定 page ID、page generation、origin、snapshot ID 和每个 ref 的 role/name fingerprint；交互前再抓 fresh ARIA snapshot 比对，拒绝 DOM 漂移和 ref 重用 (`packages/cli/src/browser/BrowserSnapshotAuthority.ts`, `packages/cli/src/browser/SessionBrowserRuntime.ts`)
- `BrowserNavigate` 临时授权一个目标 origin，commit 后才固化为页面授权；失败时只在页面仍停留原授权 origin 时保留旧授权，否则清空 (`packages/cli/src/browser/SessionBrowserRuntime.ts`)
- Browser metadata 使用显式字段投影，而页面主体放在 `<browser_data trust="untrusted">` 内并限制总量；Web 活动 Store 只解析白名单中的页面、origin、URL、错误和交互几何 (`packages/cli/src/tools/builtin/browser/browserTools.ts`, `packages/cli/web/src/store/BrowserActivityStore.ts`)
- 截图使用 SHA-256 内容寻址的私有 Session 存储，单件 8 MiB、每 Session 32 件/64 MiB；ACP 风格调用不暴露本地路径 (`packages/cli/src/browser/BrowserArtifactStore.ts`, `packages/cli/src/tools/artifacts/SessionArtifactStore.ts`)

## Decisions
- Browser 作为原生 ToolRegistry 能力而非 MCP，是为了完整复用权限、Hook、准入、取消、会话持久化和跨表面投影 (`docs/superpowers/specs/2026-08-25-native-browser-tool-design.md`, `git:90fad7fe`)
- 采用 ARIA snapshot + opaque ref，不开放 CSS/XPath/evaluate；这限制模型只能操作最新观察中明确出现的控件 (`packages/cli/src/browser/BrowserSnapshotAuthority.ts`, `packages/cli/tests/security/browser-tool-boundary.test.ts`)
- Context 是临时且 Session 隔离的，不恢复 cookies/storage；一个浏览器进程只用于资源共享，不构成跨 Session 页面状态共享 (`packages/cli/src/browser/BrowserProcessPool.ts`, `packages/cli/tests/integration/browser-tool-chromium.test.ts`)
- 浏览器进程只继承显式 OS 环境白名单并强制 `chromiumSandbox: true`，Provider 凭据和 Session 环境不进入 Chromium (`packages/cli/src/browser/BrowserInstallation.ts`, `packages/cli/src/browser/BrowserProcessPool.ts`)

## Patterns
- Navigate/Interact/Page 是 `Execute`，Snapshot/Wait/Inspect 是 `ReadOnly`，但六者都 exclusive；Plan 模式可观察现有页面，却不能导航、交互或管理页面 (`packages/cli/src/tools/builtin/browser/browserTools.ts`, `packages/cli/src/tools/registry/ToolRegistry.ts`)
- `BrowserPage(open)` 只创建 `about:blank`，新 HTTP(S) 目的地始终经 `BrowserNavigate` 形成独立权限签名 (`packages/cli/src/browser/SessionBrowserRuntime.ts`, `packages/cli/src/tools/builtin/browser/browserTools.ts`)
- URL 投影保留 query key 但把所有值替换为 `[redacted]`，并移除 fragment；诊断只保留方法、资源类型、状态和净化 URL，不记录 headers/body/cookies (`packages/cli/src/browser/BrowserSecurity.ts`, `packages/cli/src/browser/SessionBrowserRuntime.ts`)
- Web 只把无序号的 live `tool.start/tool.result` 映射为 Agent Browser 活动，durable replay 不会重新播放鼠标或 loading 状态 (`packages/cli/web/src/store/session/handlers/eventHandlers.ts`, `packages/cli/web/src/store/BrowserActivityStore.ts`)

## Resource And Failure Bounds
- ARIA snapshot 上限 48 KiB、默认深度 12/最大 20；截断按完整 UTF-8 行完成，重复 ref 直接使 snapshot 失效 (`packages/cli/src/browser/constants.ts`, `packages/cli/src/browser/BrowserSnapshotAuthority.ts`)
- console、page-error、network 各保留最新 256 项，单次最多返回 100 项且总工具输出不超过 64 KiB；容量耗尽不驱逐其他 Session (`packages/cli/src/browser/constants.ts`, `packages/cli/src/browser/SessionBrowserRuntime.ts`)
- Runtime reset/disconnect 会递增代际并清空页面与 snapshot 投影；dispose 先关闭 gate、取消 queued/active 操作，再释放 Context lease (`packages/cli/src/browser/SessionBrowserRuntime.ts`)
- Web 路由把未安装/断线/已释放映射为 503、Context 容量映射为 429、无效参数映射为 400，其余状态冲突映射为 409 (`packages/cli/src/server/routes/browser.ts`)
