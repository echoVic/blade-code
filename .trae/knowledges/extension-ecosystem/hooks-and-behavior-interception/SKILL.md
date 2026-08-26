---
name: knowledge-extension-ecosystem-hooks-and-behavior-interception
description: >
  覆盖 Tool、Permission、Session、Stop、Subagent、Compaction、Notification 与 MCP
  Elicitation 的 Hook 分支、匹配、执行后端、错误策略和摘要信任。进入条件：修改 Hook
  事件或输出、排查 Hook 未执行/误阻塞、调整 Session 开关、HTTP 安全或跨领域执行顺序。
  不包含：通用 Workspace Trust（见 ../../workspace-policy-and-shared-foundations/）、
  MCP 表单协议细节（见 ../mcp-protocol-runtime/）。关键词：HookManager、
  HookExecutor、PreToolUse、PermissionRequest、Hook Trust、Function Hook、HTTP Hook。
---

## Module Structure

Hooks 不是独立业务流程，而是在工具、权限、会话、Agent 控制流、上下文压缩和 MCP
交互处改变后续行为的横切分支；`HookManager` 绑定 Session 配置，`HookExecutor` 执行
Command、Prompt、Function 或 HTTP 后端并归并事件特定结果。

### Directory Layout
- `packages/cli/src/hooks/` — 配置、管理、匹配、执行、输出校验、信任与安全后端
- `packages/cli/src/tools/execution/ToolExecutionHooks.ts` — 工具执行管线的 Pre/Post 适配
- `packages/cli/src/server/routes/hooks.ts` — Web Session 开关与 trust/revoke API
- `packages/cli/src/slash-commands/hooks.ts` — TUI/ACP Hook 管理命令
- `packages/cli/src/ui/components/HooksManager.tsx` — TUI 配置与信任界面
- `packages/cli/web/src/components/settings/HookTrustPanel.tsx` — Web 信任审阅界面

### Key Entry Points
- `HookManager.bindSessionConfig()` in `packages/cli/src/hooks/HookManager.ts` — 冻结并关联 source/worktree 的 Session 配置
- `HookManager.executePreToolHooks()` in `packages/cli/src/hooks/HookManager.ts` — 工具前置决策与输入改写
- `HookExecutor.executeHook()` in `packages/cli/src/hooks/HookExecutor.ts` — trust gate 与后端分派
- `runPreToolUseHooks()` in `packages/cli/src/tools/execution/ToolExecutionHooks.ts` — 将 Hook 决策合并回工具准入
- `HookTrustService.getStatus()` in `packages/cli/src/hooks/HookTrustService.ts` — 校验当前外部 Hook 摘要

## Branching Table

| 分支维度 | 分支条件 | 实际行为 |
|---|---|---|
| 配置与宿主开关 | config disabled、进程禁用或 Session 暂停 | 所有事件返回各自的 pass-through 默认值，不调用 executor |
| Hook 类型信任 | Function Hook | 不进入 Hook Trust 摘要，可作为进程内宿主策略直接执行 |
| Hook 类型信任 | Command、Prompt、HTTP Hook | 仅 `trusted` 摘要执行；untrusted、modified、error 均跳过并给 warning |
| 工具权限模式 | Plan 的 PreToolUse/PostToolUse | 直接跳过这两个工具 Hook；其他生命周期事件不因 Plan 自动跳过 |
| 工具权限模式 | YOLO 的 PreToolUse | 保留 deny 和输入修改，把 ask 收敛为 allow |
| 执行顺序 | PreToolUse / PermissionRequest / Stop / Compaction | 串行执行，可短路或累积前序结果 |
| 执行顺序 | PostToolUse / PostToolUseFailure / SessionEnd | 受 `maxConcurrentHooks` 限制并行执行，再按配置顺序归并结果 |
| HTTP 目标 | 默认策略与 allowedHosts 命中 | 默认要求 HTTPS 且拒绝 loopback/私网/link-local；allowlist 命中会绕过这些限制 |
| 失败或超时 | behavior=ignore / ask / deny | 分别继续并警告、返回确认分支、或立即产生阻塞结果 |

## Affected Scope
- `packages/cli/src/tools/execution/` — 工具规则、输入重建、审批、成功/失败结果与后续诊断
- `packages/cli/src/agent/runtime/SessionRuntime.ts` — SessionStart 环境、配置快照、worktree 别名与 dispose 清理
- `packages/cli/src/agent/loop/completionPolicy.ts` — 主 Agent Stop Hook 的继续/停止决策
- `packages/cli/src/tools/builtin/task/task.ts` — SubagentStop 后续提示与再次执行
- `packages/cli/src/context/CompactionService.ts` — 手动/自动压缩前的阻断分支
- `packages/cli/src/mcp/McpClient.ts` — Elicitation 展示前和响应回传前的改写或取消
- `packages/cli/src/services/GracefulShutdown.ts` — 进程退出时触发 SessionEnd
- `packages/cli/src/plugins/PluginIntegrator.ts` — 插件 Hooks 的整批合并、来源标记与刷新恢复
- `packages/cli/src/ui/` — 用户提示提交、Session 级启停与 TUI 信任审阅
- `packages/cli/web/src/components/settings/HookTrustPanel.tsx` — Web 摘要审阅和 Session 开关

## Gotchas
- 默认配置虽然内置 `PostToolUse` 代码审查 sensor，但 `enabled=false`；仅把 Hooks 打开且不覆盖 `PostToolUse` 时才会同时启用这个默认 Prompt Hook(`packages/cli/src/hooks/HookConfig.ts`)
- Plan 模式只在 `executePreToolHooks()` 和 `executePostToolHooks()` 中显式跳过；PermissionRequest、Session、Stop、Compaction 和 Elicitation 不能据此假设自动禁用(`packages/cli/src/hooks/HookManager.ts`)
- Workspace Trust 与 Hook Trust 是两道独立门：外部 Hook 定义变化会使摘要变为 `modified` 并立即停止执行，Function Hook 则不计入摘要(`packages/cli/src/hooks/HookTrustService.ts`)
- 不带 `projectDir` 注册的 Function Hook 是 manager 级 managed matcher，会作用于所有启用了 Hooks 的项目；带 `projectDir` 才只进入该项目配置(`packages/cli/src/hooks/HookManager.ts`, `packages/cli/tests/unit/hooks/hook-trust-execution.test.ts`)
- YOLO 只把 PreToolUse 的 ask 转为 allow，不能覆盖 Hook deny；原始规则已 deny 时甚至不会运行 PreToolUse Hook(`packages/cli/src/hooks/HookManager.ts`, `packages/cli/src/tools/execution/ToolExecutionHooks.ts`)
- PreToolUse 改写参数后会重新构建 invocation、重新校验 worktree isolation 并重新计算规则权限；无效 schema 改写会作为 validation error 拒绝，而不是回退原参数(`packages/cli/src/tools/execution/ToolExecutionHooks.ts`, `packages/cli/src/tools/execution/ToolExecutor.ts`)
- `PermissionRequest` 只在合并后的决策仍为 ask 时运行，并且多个确认由 mutex 串行；它可以批准 ask 或拒绝，但不会获得改写已 deny 规则的机会(`packages/cli/src/tools/execution/ToolApprovalController.ts`)
- HTTP `allowedHosts` 命中会同时绕过 HTTPS、loopback 和私网限制，不只是添加域名白名单；配置该字段等价于显式承担目标网络边界(`packages/cli/src/hooks/HttpHookSecurity.ts`)
- `HttpHook.allowInsecureTLS` 存在于类型中，但当前 fetch 执行路径未读取该字段；不能依赖它连接自签名 HTTPS 服务(`packages/cli/src/hooks/types/HookTypes.ts`, `packages/cli/src/hooks/HookExecutor.ts`)
- Function Hook 超时只能让调用方停止等待，无法强制终止已经运行的 handler；handler 必须自行监听 `abortSignal` 并清理副作用(`packages/cli/src/hooks/HookExecutor.ts`)
- Command Hook 的 stdin 限制 100 KiB、stdout/stderr 各 1 MiB，超时或 abort 会终止完整 owned process tree；不要在 Hook 输出中传递无界工具结果(`packages/cli/src/hooks/SecureProcessExecutor.ts`, `git:61a78ea9`)
- OutputParser 只把完整 stdout 为单个 JSON object 时视为结构化 HookOutput；JSON 前后混入日志会退回退出码语义(`packages/cli/src/hooks/OutputParser.ts`)
- ApplyPatch matcher 会提取 Add/Delete/Update 和 Move to 的全部路径，任一路径命中即可触发；只检查第一个 patch 文件会漏掉后续敏感目标(`packages/cli/src/hooks/HookManager.ts`, `packages/cli/tests/unit/hooks/function-hook.test.ts`)
- source project 与 Session worktree 通过 alias 共享暂停状态，但同 workspace 的其他 Session 不受影响；释放 Runtime 时必须按 Session ID 清掉全部 alias(`packages/cli/src/hooks/HookManager.ts`, `packages/cli/tests/unit/hooks/hook-session-scope.test.ts`, `git:981afccb`)
- Prompt Hook 的模型与环境来自 Session 冻结资源并按 `session + project + model` 缓存；直接回退实时全局模型会破坏恢复 Session 的一致性(`packages/cli/src/hooks/HookExecutor.ts`, `git:852c8cba`)

## Architecture
- HookManager 保留进程级宿主开关、LRU 有界项目配置和不受 LRU 淘汰影响的 Session 快照；活动 Session 即使项目配置缓存被逐出仍保持原行为(`packages/cli/src/hooks/HookManager.ts`, `git:dff75aca`)
- PreToolUse 串行累积 `updatedInput` 并在首个 deny/ask 短路，PostToolUse 并行执行并合并 `additionalContext` 与最后一个有效 `updatedOutput`(`packages/cli/src/hooks/HookExecutor.ts`)
- Command、Prompt、Function、HTTP 四种后端统一归一到 `HookExecutionResult`，再由事件专用 reducer 转成权限、继续执行、内容注入、环境或压缩决策(`packages/cli/src/hooks/HookExecutor.ts`, `packages/cli/src/hooks/OutputParser.ts`)
- 插件 Hooks 不逐个热插拔；Integrator 保存无插件 base config，将所有 active plugins 的 Hook 追加后一次 load，刷新时再恢复 base，避免残留已卸载插件行为(`packages/cli/src/plugins/PluginIntegrator.ts`)

## Decisions
- Hook Trust 使用 canonical workspace identity 与完整外部配置摘要，而非简单目录布尔值；摘要包含 matcher、策略和插件来源，但排除不可序列化的 Function Hook(`packages/cli/src/hooks/HookTrustService.ts`, `git:a172a7c0`)
- 外部 Command Hook 只继承显式 Session 环境和 PATH/HOME/USER/SHELL 最小宿主环境，避免把任意进程凭据泄漏给仓库脚本(`packages/cli/src/hooks/SecureProcessExecutor.ts`, `git:a172a7c0`)
- 项目配置缓存限制为 64 项而 Session 配置独立持有，是为了给长期 serve 进程设驻留上限，同时不改变活动会话快照(`packages/cli/src/hooks/HookManager.ts`, `git:dff75aca`)

## Patterns
- 事件输入统一携带 `hook_execution_id`、时间戳、project、session 和 permission mode；新增事件必须同时扩展输入联合、输出 schema、manager 构造和 executor reducer(`packages/cli/src/hooks/types/HookTypes.ts`, `packages/cli/src/hooks/schemas/HookSchemas.ts`)
- Matcher 对 tools 支持精确、管道和正则，对参数支持 glob；文件工具从约定字段和 patch header 提取路径，Bash 则只从 `command` 提取匹配值(`packages/cli/src/hooks/Matcher.ts`, `packages/cli/src/hooks/HookManager.ts`)

## Branching Behavior
- 工具主链路固定为规则权限 → PreToolUse → 改写后重验 → 合并决策 → PermissionRequest/用户确认 → 执行 → PostToolUse → LSP → AutoVerify；移动 Hook 会改变权限和诊断可见性(`packages/cli/src/tools/execution/ToolExecutor.ts`)
- SessionStart 可阻止初始化或追加环境；其环境在 LSP 和 stdio MCP 创建前冻结并绑定给 HookExecutor，因此启动后修改配置不会追改这些子进程(`packages/cli/src/agent/runtime/SessionRuntime.ts`)
- Stop Hook 超时或异常按“允许停止”处理，只有明确 `continue:false` 才让 Agent 继续一轮；外层另有 30 秒保护，不能只依赖单 Hook timeout(`packages/cli/src/agent/loop/completionPolicy.ts`)
- Compaction Hook 明确 `blockCompaction:true` 才抛 `CompactionBlockedError`；Hook 自身异常 fail open，继续正常压缩或 fallback(`packages/cli/src/context/CompactionService.ts`)
- SubagentStop 明确阻止停止时，会用 `continueReason` 和已有 messages 再执行一次子代理，而不是把原因仅显示给用户(`packages/cli/src/tools/builtin/task/task.ts`)
- Elicitation Hook 可以在 UI 前直接回答或拒绝，也可以在用户回答后替换/取消；无论哪条分支，最终都必须通过原 MCP requested schema(`packages/cli/src/mcp/McpClient.ts`, `packages/cli/src/mcp/McpElicitation.ts`)
