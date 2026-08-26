---
name: knowledge-tool-and-automation-platform
description: >
  Covers Blade 工具契约、注册与执行，以及文件、搜索、Shell、worktree、Browser 和领域适配工具的协作边界。
  Navigate when: 新增工具、调整工具注册或执行顺序、排查工具副作用、并发、重试、输出投影或自动化资源生命周期。
  Excludes: 全局权限与 Workspace Trust 策略（见 ../workspace-policy-and-shared-foundations/）、MCP 协议内部生命周期（见 ../extension-ecosystem/mcp-protocol-runtime/）、Agent 轮次决策（见 ../agent-execution-and-orchestration/decision-loop-and-completion/）。
  Keywords: tools, Tool, ToolRegistry, ToolExecutor, createTool, isRetrySafe, ApplyPatch, Bash, WorktreeManager, SessionBrowserRuntime.
---

## Module Structure

该域把模型可见的工具声明、运行时准入与具体副作用适配器连接起来；`SessionRuntime`
负责组装 Session 私有依赖，Agent loop 负责提交并持久化调用，具体工具只返回统一
`ToolResult`。

### Directory Layout
- `packages/cli/src/tools/core/` — TypeBox 工具工厂与统一调用对象
- `packages/cli/src/tools/types/` — 工具、调用、结果与执行上下文契约
- `packages/cli/src/tools/registry/` — 内置、延迟加载与动态 MCP 工具目录
- `packages/cli/src/tools/execution/` — 权限、Hook、准入、锁、调用与验证管线
- `packages/cli/src/tools/builtin/` — 文件、Shell、Browser 与工作流工具适配器
- `packages/cli/src/browser/` — Session 隔离的 Playwright 自动化运行时
- `packages/cli/src/worktree/` — 托管 Git worktree 的创建、交付和清理
- `packages/cli/src/services/FileSystemService.ts` — 本地与 ACP 文件系统抽象

### Key Entry Points
- `getBuiltinTools()` in `packages/cli/src/tools/builtin/index.ts` — 按 Session 能力组装内置工具
- `ToolRegistry` in `packages/cli/src/tools/registry/ToolRegistry.ts` — 维护可发现工具及动态 MCP 投影
- `ToolExecutor.execute()` in `packages/cli/src/tools/execution/ToolExecutor.ts` — 执行单次工具调用的统一入口
- `StreamingToolExecutor` in `packages/cli/src/agent/loop/StreamingToolExecutor.ts` — 将 Provider 流式 tool call 接入持久化与执行

## Gotchas
- `ToolKind` 只参与权限和容量分类，`isConcurrencySafe`、`parallelism` 与 `isRetrySafe` 是三个独立维度；不能因工具是 `ReadOnly` 就推断它可并发、可流式预启动或可重放 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/core/createTool.ts`)
- 工具瞬态异常重试默认 fail-closed；未显式声明 `isRetrySafe: true` 的调用只执行一次，避免在完成状态不确定时重复外部副作用 (`packages/cli/src/tools/execution/ToolInvocationRunner.ts`, `packages/cli/tests/unit/tooling/tools/builtin/tool-retry-safety.test.ts`)
- `Browser` 自动化与 Web UI 的 iframe Preview 是两个独立运行时；前者由 Session 持有 Playwright Context，后者不能被 Agent 工具直接操纵 (`packages/cli/src/browser/SessionBrowserRuntime.ts`, `packages/cli/web/src/components/preview/BrowserPreview.tsx`)
- Session 关闭必须同时回收执行器队列、后台进程、Browser Context、文件访问记录和 worktree 内存绑定；只释放其中一个会留下跨轮次资源或容量占用 (`packages/cli/src/agent/runtime/SessionRuntime.ts`)
- `ExecutionPipeline` 只是 `ToolExecutor` 的兼容别名，新代码若沿用旧“固定阶段类”心智模型会误判当前真实调用顺序 (`packages/cli/src/tools/execution/ExecutionPipeline.ts`, `git:e6a1bef4`)

## Architecture
- 主链路是 `getBuiltinTools`/MCP 工具投影 → `ToolRegistry` → Agent loop → `ToolExecutor` → invocation；Schema、权限签名、并发、重试和展示数据都沿这一条统一契约传播 (`packages/cli/src/tools/builtin/index.ts`, `packages/cli/src/tools/registry/ToolRegistry.ts`, `packages/cli/src/tools/execution/ToolExecutor.ts`)
- `SessionRuntime` 先构造带 Browser、LSP、Skill、Task 等 Session 私有依赖的基础注册表，再为不同 Agent 按 allow/deny 过滤克隆目录，避免共享动态加载和审批状态 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/tools/registry/ToolRegistry.ts`)
- 文件、Shell 与 Browser 各自拥有额外的状态一致性边界：文件依赖读取记录和事务，Shell 依赖进程租约，Browser 依赖 Context/页面/快照代际；通用执行器不替代这些领域内保护 (`packages/cli/src/tools/builtin/file/FileAccessTracker.ts`, `packages/cli/src/context/storage/DurableProcessLeaseStore.ts`, `packages/cli/src/browser/BrowserSnapshotAuthority.ts`)
- `ToolResult` 同时承载给模型的 `llmContent`、稳定错误类型和跨表面的 metadata；TUI、Headless、Server 与 ACP 再通过统一 projector 做各自长度裁剪 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/display/ToolResultProjector.ts`)

## Decisions
- 工具系统已从 11 阶段对象管线迁移为平铺执行器，以显式函数组合表达顺序；保留旧导出仅用于兼容现有 import (`packages/cli/src/tools/execution/ExecutionPipeline.ts`, `packages/cli/src/tools/execution/ToolExecutor.ts`, `git:e6a1bef4`)
- 工具 schema 统一迁移到 TypeBox，并在发送给 Provider 前去除运行时注解和关闭未知对象字段，避免手写 JSON Schema 与运行时校验漂移 (`packages/cli/src/tools/validation/schemaToJson.ts`, `packages/cli/src/tools/validation/schemaErrorFormatter.ts`, `git:311ba368`)
- Browser 选择原生工具而非 MCP 或 iframe 控制，是为了复用 Blade 的权限、Hook、Session、取消和持久化语义，同时保持一个进程、多 Session Context 的资源模型 (`docs/superpowers/specs/2026-08-25-native-browser-tool-design.md`, `git:90fad7fe`)

## Patterns
- 能力适配器通过 `createTool` 返回声明与执行一体的对象，Session 依赖通过工厂参数注入；模块级单例仅用于真正的进程级资源 (`packages/cli/src/tools/core/createTool.ts`, `packages/cli/src/tools/builtin/index.ts`)
- 任何可能产生副作用的长生命周期资源都使用显式 owner/session identity 和幂等 dispose/release，恢复路径先验证身份再清理 (`packages/cli/src/context/storage/DurableProcessLeaseStore.ts`, `packages/cli/src/browser/BrowserProcessPool.ts`)
- 大输出先在生产端有界保留，再在表面投影层二次裁剪；持久记录保留计数和截断事实，避免 UI 限制反向改变执行语义 (`packages/cli/src/tools/builtin/shell/ShellOutputCapture.ts`, `packages/cli/src/tools/display/ToolResultProjector.ts`)

## Child Knowledge Nodes
- `./tool-contracts-and-registry/SKILL.md` — Navigate when: 定义工具、调整 TypeBox schema、注册表、延迟发现、MCP 工具目录或通用制品存储
- `./tool-execution-pipeline/SKILL.md` — Navigate when: 调整执行顺序、权限/Hook、并发准入、文件锁、重试、取消、自动验证或结果投影
- `./filesystem-search-and-atomic-patching/SKILL.md` — Navigate when: 修改 Read/Write/Edit/ApplyPatch、快照回退、Glob/Grep 或 ACP 文件语义
- `./shell-process-and-worktree/SKILL.md` — Navigate when: 修改 Bash、后台输入输出、进程租约/回收、写沙箱或托管 worktree
- `./browser-automation/SKILL.md` — Navigate when: 修改 Chromium 池、Session Browser、ARIA ref、同源边界、诊断、截图或 Web Browser 面板
- `./integration-and-workflow-tool-adapters/SKILL.md` — Navigate when: 修改领域能力的工具适配、Session 条件注入、ToolSearch 或 MCP/Goal/Task/LSP/Web 工具集合
