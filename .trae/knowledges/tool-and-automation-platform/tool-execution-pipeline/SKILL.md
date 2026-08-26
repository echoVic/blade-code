---
name: knowledge-tool-execution-pipeline
description: >
  Covers ToolExecutor 的验证、worktree 隔离、权限、Hook、审批、并发准入、文件锁、调用重试、LSP/AutoVerify 后处理与结果投影。
  Navigate when: 修改工具执行顺序、排查重复副作用、权限或 Hook 覆盖、队列拥塞、取消、同路径写竞争、自动验证或跨表面输出。
  Excludes: 工具 schema/注册表定义（见 ../tool-contracts-and-registry/）、具体文件/Shell/Browser 内部语义（见相邻节点）。
  Keywords: ToolExecutor, executeToolInvocation, isRetrySafe, PermissionResolver, ToolConcurrencyGate, ConcurrencyScheduler, FileLockManager, AutoVerifyRuntime, StreamingToolExecutor.
---

## Module Structure

该组件把已注册工具调用变成受控副作用。执行器本身无 Session 持久状态，但通过
`ExecutionContext` 接收 Session 身份、工作区、权限、取消和交互处理器，并协调多个
进程级与 Session 级资源门。

### Directory Layout
- `packages/cli/src/tools/execution/ToolExecutor.ts` — 当前平铺执行流程与历史记录
- `packages/cli/src/tools/execution/ToolInvocationRunner.ts` — 调用计时与显式安全重试
- `packages/cli/src/tools/execution/PermissionResolver.ts` — 规则、模式、Session 批准与敏感路径合并
- `packages/cli/src/tools/execution/ToolExecutionHooks.ts` — Pre/Post Hook 适配及参数重建
- `packages/cli/src/tools/execution/ToolConcurrencyGate.ts` — 单执行器 shared/exclusive FIFO 屏障
- `packages/cli/src/tools/execution/ConcurrencyScheduler.ts` — 全局、Session、ToolKind 多维容量调度
- `packages/cli/src/tools/execution/FileLockManager.ts` — canonical 路径锁与稳定顺序多锁
- `packages/cli/src/tools/execution/AutoVerify.ts` — 受信任本地编辑后的 Session-owned 类型诊断
- `packages/cli/src/agent/loop/StreamingToolExecutor.ts` — 流式预启动、持久化和结果有序交付
- `packages/cli/src/tools/display/ToolResultProjector.ts` — durable 结果恢复与表面裁剪

### Key Entry Points
- `ToolExecutor.execute()` in `packages/cli/src/tools/execution/ToolExecutor.ts` — 创建 execution identity 并运行完整流程
- `executeToolInvocation()` in `packages/cli/src/tools/execution/ToolInvocationRunner.ts` — 执行 invocation、记录耗时并实施重试策略
- `StreamingToolExecutor.addTool()` in `packages/cli/src/agent/loop/StreamingToolExecutor.ts` — 决定预启动、排队或拒绝一次流式调用
- `AutoVerifyRuntime.verify()` in `packages/cli/src/tools/execution/AutoVerify.ts` — 对成功文件写入追加相关类型错误

## API Surface

### `ToolExecutor`
- `execute(toolName, params, context)` — 合并默认上下文并执行一次完整受控调用
- `executeAll()` / `executeParallel()` — 保序收集批量结果，底层仍通过相同 gate 与 scheduler
- `getExecutionHistory()` / `getStats()` — 读取有界内存执行历史与聚合统计
- `dispose()` — 关闭本执行器 gate、取消该 owner 的排队任务并释放注入资源

### Execution Coordination
- `ToolConcurrencyGate.run()` — 在一个 executor 内提供 shared 并行和 exclusive FIFO 屏障
- `ConcurrencyScheduler.schedule()` — 在进程与 Session 两级按 `ToolKind` 公平准入
- `FileLockManager.acquireLock()` / `acquireLocks()` — 按 canonical 路径串行写入并避免多锁死锁
- `ToolTurnAdmission.admit()` — 将单轮 tool call 数限制为 64

### Execution Policies
- `PermissionResolver.resolveRulePermission()` — 生成权限签名并应用审计代理、模式、Session 批准和敏感文件覆盖
- `runPreToolUseHooks()` / `runPostToolUseHooks()` — 在审批前修改输入、收紧决策并在执行后修改输出
- `executeToolInvocation()` — 仅对显式 `isRetrySafe` invocation 的指定瞬态异常做有界重放
- `formatToolResult()` — 补齐 execution ID、工具名和完成时间戳

## Usage Examples

### Session 创建隔离的执行器
```typescript
return new ToolExecutor(registry, {
  permissionConfig: permissions,
  permissionMode,
  approvalStore: this.approvalStore,
  contextDefaults: { sessionId: this.sessionId, workspaceRoot: this.workspaceRoot },
  ...(permissionMode === PermissionMode.YOLO ? { autoVerifyRuntime } : {}),
});
```

### Agent loop 通过统一入口执行
```typescript
const result = this.executeTool
  ? await this.executeTool(toolCall.function.name, params, execContext)
  : await this.pipeline.execute(toolCall.function.name, params, execContext);
```

## Gotchas
- 重试策略默认 fail-closed：`isRetrySafe` 缺省时 `maxRetries=0`，只有显式 opt-in 的 invocation 才会对 `EBUSY`、`EAGAIN`、`EMFILE`、`ENFILE` 最多重试两次 (`packages/cli/src/tools/execution/ToolInvocationRunner.ts`, `packages/cli/src/tools/core/createTool.ts`)
- 重试只捕获 `execute()` 抛出的异常；工具正常返回 `{ success: false }` 不会重试，调用方也不应通过抛错规避领域失败契约 (`packages/cli/src/tools/execution/ToolInvocationRunner.ts`, `packages/cli/src/tools/types/ToolTypes.ts`)
- `ToolKind.ReadOnly`、`isConcurrencySafe`、`parallelism` 与 `isRetrySafe` 不可互相推导；当前白名单测试只允许 11 个经审计的查询工具重放，Bash、Edit、Write、WriteStdin、Browser 与外部 MCP 均保持不可重放 (`packages/cli/tests/unit/tooling/tools/builtin/tool-retry-safety.test.ts`, `packages/cli/src/tools/types/ToolTypes.ts`)
- retry-safe 工具的线性退避为 200ms、400ms，使用调用信号可中止；取消发生在退避期时不会启动下一次尝试 (`packages/cli/src/tools/execution/ToolInvocationRunner.ts`, `packages/cli/tests/unit/tooling/tools/execution/tool-invocation-runner.test.ts`)
- PreToolUse Hook 修改参数后，执行器会重新构建 invocation，并重新检查 worktree 边界与规则权限；若只更新 params 而复用旧 invocation 会绕过 schema 和受影响路径 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/tools/execution/ToolExecutionHooks.ts`)
- Hook 只能把规则结果收紧为 ask/deny，不能把规则 deny/ask 放宽为 allow；无任何决策时默认 ask (`packages/cli/src/tools/execution/PermissionResolver.ts`)
- `parallelism: 'shared'` 只穿过单执行器批内 gate，仍会受全局/Session/ToolKind scheduler 以及同路径文件锁限制；它不等于无限并发 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/tools/execution/ConcurrencyScheduler.ts`)
- 通用文件锁只识别 `file_path` 或 `notebook_path` 且仅在 `isConcurrencySafe=false` 时启用；`ApplyPatch` 因为是多路径工具，必须在工具内部获取排序后的完整路径锁 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/tools/builtin/file/applyPatch.ts`)
- `formatToolResult()` 原地补写 metadata；PostToolUse Hook、LSP 和 AutoVerify 都在它之前运行，因此这些阶段看到的不是最终 execution metadata (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/tools/execution/ToolInvocationRunner.ts`)
- 执行已开始后再收到取消会返回 `abortedBeforeLaunch=false`，不能据此断言副作用未发生；只有 gate/scheduler 前取消才明确是未启动 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/tools/execution/ToolExecutionResults.ts`)
- `ExecutionPipeline.ts` 已弃用且只重导出 `ToolExecutor`；新增阶段类或依赖旧 11 阶段顺序不会进入真实路径 (`packages/cli/src/tools/execution/ExecutionPipeline.ts`, `git:e6a1bef4`)

## Architecture
- 当前固定顺序是查找工具 → schema/allow-deny 列表校验 → executor gate → worktree 隔离 → 规则权限 → PreToolUse Hook → Hook 改参后重校验 → 决策合并 → 审批 → scheduler/文件锁 → invocation → PostToolUse Hook → LSP → AutoVerify → 结果格式化 (`packages/cli/src/tools/execution/ToolExecutor.ts`)
- 并发分两层：`ToolConcurrencyGate` 保留同批 exclusive 屏障顺序，`ConcurrencyScheduler` 再实施进程级和 Session 级总量及 kind 配额，并按 Session 轮转避免饥饿 (`packages/cli/src/tools/execution/ToolConcurrencyGate.ts`, `packages/cli/src/tools/execution/ConcurrencyScheduler.ts`)
- `StreamingToolExecutor` 只为 allowlist 且 `isConcurrencySafe=true` 的工具在 Provider 流提交前预启动；`parallelism` 只决定流结束后的批内屏障，不能扩大预启动集合 (`packages/cli/src/agent/loop/StreamingToolExecutor.ts`)
- durable tool-use 在调用前按原始顺序串行写入；要求持久化却无法保存时，调用在副作用前失败，model fallback 则通过 epoch 丢弃旧世代结果 (`packages/cli/src/agent/loop/StreamingToolExecutor.ts`)
- admission queue 满或超时会被投影为 `RESOURCE_EXHAUSTED/tool_busy` 且提示下一轮重试；executor/scheduler 关闭则投影为 dispose/cancel，而不是普通业务失败 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/tools/execution/ConcurrencyScheduler.ts`)

## Decisions
- 平铺执行器取代 staged pipeline 后，安全顺序通过单个 `runTool` 明文维护，减少阶段对象间隐式状态，但修改顺序时必须同步集成测试 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/tests/integration/tool-executor.test.ts`, `git:e6a1bef4`)
- 工具容量采用全局共享 scheduler 加 Session 公平轮转，默认总并发 32、单 Session 10，并按 readonly/write/execute 分别限流，防止单 Session 或进程工具占满资源 (`packages/cli/src/tools/execution/ConcurrencyScheduler.ts`, `git:527cb02b`)
- 自动验证只在 Session 为 YOLO 且工作区明确 trusted、文件属于本地 Session 时注入；项目脚本不会因普通编辑在未信任或 ACP 文件上隐式执行 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `packages/cli/src/tools/execution/AutoVerify.ts`)

## Patterns
- 所有预执行拒绝都返回统一 `ToolResult`，而异常路径交给 `failExecution` 并额外运行 `PostToolUseFailure` Hook；两条路径的 Hook 行为不同 (`packages/cli/src/tools/execution/ToolExecutor.ts`, `packages/cli/src/tools/execution/ToolExecutionResults.ts`)
- 审批请求通过 mutex 串行化，但审批完成后的工具可继续 shared 执行；Session 或 project scope 的批准分别进入内存 store 或本地配置 (`packages/cli/src/tools/execution/ToolApprovalController.ts`, `packages/cli/src/tools/execution/SessionApprovalStore.ts`)
- AutoVerify 对同 workspace、同文件指纹合并并发检查，输入变化则排到旧检查之后；仅执行项目声明的 `type-check` script，不调用 `npx` 猜测工具链 (`packages/cli/src/tools/execution/VerifyQueue.ts`)
- Tool progress 使用有界 256 项队列，溢出丢最旧项；进度是观测数据，不参与准入所有权 (`packages/cli/src/agent/loop/ToolProgressQueue.ts`, `packages/cli/src/tools/execution/ConcurrencyScheduler.ts`)

## Consumer Analysis
- `packages/cli/src/agent/loop/` 是主要调用方：流式路径负责预启动、tool-use 持久化、单轮 64 调用上限和有序回收，最终仍委托 `ToolExecutor.execute` (`packages/cli/src/agent/loop/StreamingToolExecutor.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`)
- `packages/cli/src/agent/runtime/SessionRuntime.ts` 为每个 Agent 创建过滤后的 executor，共享 Session approval store，并只在 YOLO 模式注入 AutoVerify (`packages/cli/src/agent/runtime/SessionRuntime.ts`)
- `packages/cli/src/acp/Session.ts`、`packages/cli/src/commands/headless.ts`、`packages/cli/src/server/routes/session.ts` 消费统一 ToolResult，再按各自字符预算投影详情，不能绕过 canonical result (`packages/cli/src/tools/display/ToolResultProjector.ts`)
- `packages/cli/src/hooks/` 通过 Pre/Post/Failure 三类接点影响参数、决策或输出；权限 Hook 的 allow 不能覆盖规则拒绝 (`packages/cli/src/tools/execution/ToolExecutionHooks.ts`, `packages/cli/src/tools/execution/PermissionResolver.ts`)
- 文件工具、LSP 与自动验证共同消费执行后的结果顺序：Post Hook 可改结果，LSP 更新文档状态，AutoVerify 最后追加诊断 (`packages/cli/src/tools/execution/ToolExecutor.ts`)
