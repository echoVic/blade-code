---
name: knowledge-permissions-and-workspace-trust
description: >
  覆盖工具 allow/ask/deny、四种 permission mode、审批持久化、Workspace/Hook Trust、敏感文件以及 Hook/Browser 网络边界。
  使用时机：修改工具授权、排查为何调用被自动批准或拒绝、增加项目级可执行资源、处理信任继承、SSRF 或敏感路径。
  不包含：配置文件通用合并见 layered-configuration-and-runtime-settings，工具执行阶段与并发见 tool-and-automation-platform/tool-execution-pipeline。
  关键词：PermissionChecker, PermissionResolver, ToolApprovalController, WorkspaceTrustService, HookTrustService, SensitiveFileDetector, YOLO, PLAN。
---

## Module Structure

权限系统先把工具调用归一化成规则签名，再应用运行模式、Session 审批和路径安全覆盖；Workspace Trust 则在资源加载前决定仓库控制的配置、命令和指令是否可见，外部 Hook 还需要独立摘要信任。

### Directory Layout
- `packages/cli/src/config/PermissionChecker.ts` — allow/ask/deny 规则和工具签名匹配
- `packages/cli/src/tools/execution/PermissionResolver.ts` — 模式、审计 Agent、Session 记忆和敏感路径覆盖
- `packages/cli/src/tools/execution/ToolApprovalController.ts` — 串行审批、Hook 审批和 project/session scope
- `packages/cli/src/tools/execution/ToolExecutionGuards.ts` — CLI 白黑名单与 worktree 边界
- `packages/cli/src/tools/validation/SensitiveFileDetector.ts` — 凭据、环境文件和敏感目录分类
- `packages/cli/src/security/WorkspaceIdentity.ts` — canonical project 与 linked worktree trust root
- `packages/cli/src/security/WorkspaceTrustService.ts` — 项目来源审阅、继承决策和安全存储
- `packages/cli/src/hooks/HookTrustService.ts` — 外部 Hook 配置摘要信任
- `packages/cli/src/hooks/HttpHookSecurity.ts` — Hook URL 协议和内网限制
- `packages/cli/src/browser/BrowserSecurity.ts` — Browser origin、凭据控件和公开 URL 脱敏

### Decision Entry
- `PermissionChecker.check()` — 规则级 `deny > allow > ask > default ask`
- `PermissionResolver.resolveRulePermission()` — 审计 Agent、permission mode、Session 记忆和敏感路径的组合入口
- `resolvePermissionDecision()` — 规则结果与 PreToolUse Hook 决策的收紧合并
- `WorkspaceTrustService.getStatus()` — 计算 `not_required | trusted | untrusted | error`
- `HookTrustService.getStatus()` — 依据外部 Hook canonical digest 判断 `trusted | modified`

## Branching Table

| 工具/规则条件 | `default` | `autoEdit` | `plan` | `yolo` |
|---------------|-----------|------------|--------|--------|
| 未匹配的 ReadOnly | 自动允许 | 自动允许 | 自动允许 | 自动允许 |
| 未匹配的 Write | 请求确认 | 自动允许 | 拒绝 | 自动允许 |
| 未匹配的 Execute | 请求确认 | 请求确认 | 拒绝 | 自动允许 |
| 显式 allow 的 Write/Execute | 允许 | 允许 | 仍拒绝 | 允许 |
| 显式 deny 的普通工具调用 | 拒绝 | 拒绝 | 拒绝 | 当前实现先被模式改写为允许 |
| verification/review Agent 的写入或变异命令 | 拒绝 | 拒绝 | 拒绝 | 在模式覆盖前拒绝 |
| 中高敏感文件路径 | allow 会降为 ask，其余高敏感请求拒绝 | allow 会降为 ask，其余高敏感请求拒绝 | 写操作先拒绝 | 模式 allow 仍会降为 ask |

## Affected Scope
- `packages/cli/src/tools/execution/` — 每次工具调用的规则、Hook、审批和 safety override
- `packages/cli/src/agent/runtime/SessionRuntime.ts` — Session 权限模式恢复与 workspace 规则装配
- `packages/cli/src/config/ConfigManager.ts` — 可信项目权限、环境和可执行配置的过滤
- `packages/cli/src/plugins/` — 未信任项目的插件发现和启用阻断
- `packages/cli/src/skills/` 与 `packages/cli/src/slash-commands/custom/` — 项目 Skill/命令的 trust gate
- `packages/cli/src/hooks/` — Folder Trust 之外的外部 Hook 摘要信任和 HTTP 安全
- `packages/cli/src/browser/` — URL/origin 分类、凭据控件和远端副作用审批
- `packages/cli/src/server/routes/permission.ts` 与 `packages/cli/src/server/routes/workspaceTrust.ts` — Web 审批和信任操作

## Gotchas
- 生产 `PermissionResolver` 在普通工具路径中先处理 `yolo`，因此会把 `PermissionChecker` 的显式 deny 改写为 allow；之后只有 Hook 或路径 safety override 能再次收紧，不能根据旧的辅助测试假定 deny 一定高于 yolo (`packages/cli/src/tools/execution/PermissionResolver.ts`, `packages/cli/tests/unit/config-security/permissions/permission-modes.test.ts`)
- 高敏感文件不会因普通 allow 或 yolo 直接放行：已有 allow 会被降为 ask，未获 allow 的高敏感访问直接 deny；危险系统路径始终 deny (`packages/cli/src/tools/execution/PermissionResolver.ts`)
- PreToolUse Hook 修改参数后会重建 invocation、重跑 worktree 隔离并重新计算规则决策；只检查原始参数会漏掉 Hook 引入的路径或命令风险 (`packages/cli/src/tools/execution/ToolExecutor.ts`)
- Hook 决策只能收紧已有规则：rule deny 不可被 Hook allow 放宽，rule ask 也不可被 Hook allow 跳过；双方都是 ask 时保留 Hook 的场景化原因 (`packages/cli/src/tools/execution/PermissionResolver.ts`, `packages/cli/tests/unit/tooling/tools/execution/permission-resolver.test.ts`)
- 非交互表面没有 `confirmationHandler` 时，ask 不是隐式允许；除 yolo 外会返回结构化权限拒绝 (`packages/cli/src/tools/execution/ToolApprovalController.ts`)
- project scope 审批写入目标 workspace 的 `.blade/settings.local.json`，而不是服务器启动 cwd；工具没有 `abstractPermissionRule()` 或返回空串时不得持久化宽泛授权 (`packages/cli/src/tools/execution/ToolApprovalController.ts`, `git:7b34bd7e`)
- Session scope 记忆只绑定当前 `permissionSignature`，参数变化会形成新签名并再次审批；project scope 才会写可复用抽象规则 (`packages/cli/src/tools/execution/ToolApprovalController.ts`, `packages/cli/src/tools/execution/SessionApprovalStore.ts`)
- Folder Trust 不等于 Hook Trust；仅含 Hook 的 settings 不触发 Folder Trust，但 command/http/prompt Hook 仍需按完整外部配置摘要单独批准，任何摘要变化都会进入 `modified` (`packages/cli/src/security/WorkspaceTrustService.ts`, `packages/cli/src/hooks/HookTrustService.ts`)
- linked worktree 的 trust root 会映射到 common checkout 并保留 monorepo 子路径；直接用临时 worktree 绝对路径存决策会产生重复或错误信任身份 (`packages/cli/src/security/WorkspaceIdentity.ts`)
- trust store 或 decision 文件的 owner、权限、schema、符号链接任一不符都会返回 error/fail closed；不要用普通 JSON 写入替代服务的 `0600` 原子写 (`packages/cli/src/security/WorkspaceTrustService.ts`)
- Hook HTTP allowlist 命中会同时绕过 HTTPS、loopback 和私网限制；新增通配 host 时必须把它视为完整网络信任，而不只是域名过滤 (`packages/cli/src/hooks/HttpHookSecurity.ts`)
- Browser URL 禁止内嵌 credentials，并把 query value 投影成 `[redacted]`；日志或审批预览不应绕过 `projectBrowserUrl()` 输出原始查询参数 (`packages/cli/src/browser/BrowserSecurity.ts`)

## Architecture
- 工具权限执行顺序为参数/白黑名单验证 → worktree 边界 → 规则与模式 → PreToolUse Hook → 参数变更后重新检查 → 规则/Hook 合并 → 串行人工审批 → scarce execution permit (`packages/cli/src/tools/execution/ToolExecutor.ts`)
- Workspace Trust 审阅 package scripts、项目配置、插件、命令、Skills、Agents 和项目指令，但只投影受限摘要；环境变量只暴露名称，URL 去掉 query/credential (`packages/cli/src/security/WorkspaceTrustService.ts`)
- Workspace 决策按最具体祖先生效，父目录 trust 可继承，子目录 revoke 可覆盖；决策身份是 canonical trust root 的 SHA-256 (`packages/cli/src/security/WorkspaceTrustService.ts`)

## Decisions
- 验证/代码审查 Agent 的只读边界在 permission mode 之前执行，即使父 Session 是 yolo，也只能运行经过语义识别的只读或验证命令 (`packages/cli/src/tools/execution/PermissionResolver.ts`)
- 项目 Hook 使用独立 digest 信任而不是复用 Folder Trust，防止仓库在已信任后悄悄修改可执行 Hook (`packages/cli/src/hooks/HookTrustService.ts`, `git:a172a7c`)
- trust/identity 缓存改为有界 LRU，防止长期多项目服务因历史 workspace 数量持续保留策略状态 (`packages/cli/src/security/WorkspaceIdentity.ts`, `packages/cli/src/security/WorkspaceTrustService.ts`, `git:dff75aca`, `git:47ca3370`)

## Branching Behavior
- 无敏感项目来源时状态为 `not_required`；存在敏感来源但无有效决策时为 `untrusted`；读取 trust store 失败时为 `error`，后二者均不得加载项目执行资源 (`packages/cli/src/security/WorkspaceTrustService.ts`)
- 不可信项目配置中的普通字段被忽略，但 Hook 字段仍可进入独立摘要审阅，`disableAllHooks=true` 还可作为单向收紧生效 (`packages/cli/src/config/ConfigManager.ts`)
- 普通只读 Bash 在规则默认为 ask 时可由语义分类自动放行，但显式 deny 仍先命中；verification Agent 还要求无后台执行、无 env 覆盖且 cwd 位于 workspace 内 (`packages/cli/src/tools/execution/PermissionResolver.ts`)
- Browser public、private-network 和 loopback origin 会形成不同审批签名；交互还绑定 canonical `expectedOrigin`，页面跳转后不能复用旧快照权限 (`packages/cli/src/browser/BrowserSecurity.ts`, `packages/cli/src/tools/execution/ToolApprovalController.ts`)
- Trust/Revoke 后先发布过滤后的启动配置，再断开 MCP 和重建 workspace 资源，避免旧可执行资源在新策略下继续被发现 (`packages/cli/src/security/reloadWorkspaceTrust.ts`, `packages/cli/tests/unit/security/reload-workspace-trust.test.ts`)
