---
name: knowledge-workspace-policy-and-shared-foundations
description: >
  覆盖 Blade 跨 Agent、工具、扩展和交互表面的配置、Workspace Trust、Session 资源快照、共享 TypeBox 合约、容量准入与关闭策略。
  使用时机：修改全局策略、排查多 workspace 串扰、增加共享配置或 API 字段、处理资源耗尽、背压与进程回收。
  不包含：具体工具实现见 tool-and-automation-platform，Provider 重试与熔断见 model-and-provider-runtime，Session 事件持久化见 session-state-and-context。
  关键词：ConfigManager, WorkspaceTrustService, SessionAgentResources, RuntimeSchema, admission, egress, shutdown, workspace isolation。
---

## Module Structure

该域集中描述会跨越 CLI、Web、ACP、Agent Runtime、工具和扩展系统的基础策略；其共同约束是以 source project 建立身份，在进入 Session 前完成信任过滤和配置解析，再把可变进程资源冻结为 Session 私有视图。

### Directory Layout
- `packages/cli/src/config/` — 配置加载、归一化、字段持久化路由和权限规则
- `packages/cli/src/security/` — canonical workspace identity 与 Folder Trust 决策
- `packages/cli/src/agent/resources/` — workspace registry、模型资源和 Session 快照
- `packages/cli/src/api/` — Server/Web 共用的请求、响应和事件合约
- `packages/cli/src/schema/` — TypeBox runtime 解析与错误归一化
- `packages/cli/src/tools/execution/` — 权限、批内 gate 和进程级工具准入
- `packages/cli/src/utils/BoundedSerialEgress.ts` — 多表面共用的有界串行输出
- `packages/cli/src/services/GracefulShutdown.ts` — 进程级关闭编排

### Decision Entry
- `ConfigManager.initialize()` in `packages/cli/src/config/ConfigManager.ts` — 启动配置、信任过滤和显式运行时覆盖入口
- `WorkspaceTrustService.getStatus()` in `packages/cli/src/security/WorkspaceTrustService.ts` — 项目资源是否可见的身份决策入口
- `SessionRuntime.create()` in `packages/cli/src/agent/runtime/SessionRuntime.ts` — 将 source project 配置与资源冻结到 Session
- `Runtime()` in `packages/cli/src/schema/index.ts` — 共享 schema 的运行时解析入口
- `ConcurrencyScheduler.schedule()` in `packages/cli/src/tools/execution/ConcurrencyScheduler.ts` — 工具进程级公平准入入口
- `BoundedSerialEgress.offer()` in `packages/cli/src/utils/BoundedSerialEgress.ts` — Web、ACP 与 Headless 输出背压入口

## Branching Table

| 决策维度 | 主路径 | 受限或替代路径 |
|----------|--------|----------------|
| 配置身份 | 启动 workspace 可复用 Store 投影 | 其他 workspace 必须从用户层和目标项目层重建，不能继承启动项目私有层 |
| 项目来源 | `trusted` 项目可加载配置、插件、规则和可执行资源 | `untrusted` 或 trust store 错误时忽略可放宽执行面的项目来源 |
| 资源时点 | workspace registry 可刷新并参与后续 Session 创建 | 活动 Session 使用深复制快照，不接受 registry 热更新 |
| 边界数据 | schema 解析成功后应用默认值并清理未知字段 | 输入验证失败映射为 4xx，输出投影失败则阻止泄漏内部字段 |
| 容量状态 | 有空位时直接取得 permit 或 lease | 等待时受数量、字节和超时约束；满载时返回 typed capacity failure |
| 输出状态 | 单写者按接纳顺序排空并支持 high-water-mark flush | overflow、写超时或 committed seq 回退会关闭对应输出通道 |
| 生命周期 | owner 活跃时持有 Session、Browser、进程和排队项 | cancel/dispose/shutdown 逐层撤销等待者并等待实际资源回收 |

## Affected Scope
- `packages/cli/src/agent/runtime/` — Session 创建、资源快照、任务准入和驻留生命周期
- `packages/cli/src/tools/` — 工具 schema、权限决策、并发 gate 和外部副作用边界
- `packages/cli/src/server/` — Hono API 校验、SSE 顺序、容量错误映射和关闭清理
- `packages/cli/src/acp/` — 多 cwd Session 隔离、不可驱逐驻留与有界更新输出
- `packages/cli/src/commands/` — CLI 覆盖、Headless 输出背压和进程级启动/关闭
- `packages/cli/src/plugins/` — 可信项目来源、配置收紧和 workspace registry 刷新
- `packages/cli/src/browser/` — HTTP(S) 来源安全、Context 容量和串行页面操作
- `packages/cli/web/src/` — 共享 API schema 消费、workspace 模型投影和容量状态展示

## Gotchas
- 进程 Store 只代表启动 workspace 的 UI 投影；为 Web 多项目、ACP 多 cwd 或 Task source project 创建 Runtime 时直接读取 Store 会泄漏模型、权限、MCP、LSP 或环境配置 (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`, `git:3549bb1e`)
- `projectRoot` 是配置和资源身份，`workspaceRoot` 是文件副作用位置；worktree 只替换后者，不能据此重新选择插件、Provider 或项目规则 (`packages/cli/src/agent/runtime/SessionRuntime.ts`, `docs/reference/workspace-agent-resources.md`)
- Workspace Trust 变更不是单纯更新一个布尔值；当前启动配置必须先重载，随后断开 MCP、清空 workspace registry 并重新解析资源 (`packages/cli/src/security/reloadWorkspaceTrust.ts`)
- 新增跨表面字段若只改 TypeScript 接口会留下不一致边界；通常还要同步默认值、配置校验/持久化路由、共享 API schema、公开投影和客户端解析 (`packages/cli/src/config/types.ts`, `packages/cli/src/config/defaults.ts`, `packages/cli/src/api/schemas.ts`)
- 容量拒绝是可恢复协议的一部分，不应被折叠成通用 500；Session、Task、Tool、Provider 和 Browser 各自携带稳定的 resource/reason/limit 语义 (`packages/cli/src/context/taskFailure.ts`, `packages/cli/src/server/error.ts`)
- 输出队列失败采用 fail-closed；继续向已经 overflow 或 timeout 的通道写入会破坏顺序与内存上限，因此调用方必须关闭对应订阅或会话，而不是重试同一 writer (`packages/cli/src/utils/BoundedSerialEgress.ts`)

## Architecture
- 跨域策略按“磁盘来源 → 信任过滤 → workspace 解析 → Session 快照 → 执行时准入 → 有界表面输出”串联，任何中间层都不应绕回进程全局可变状态 (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- 配置、资源目录与运行时状态拥有不同所有者：`ConfigManager` 读盘，`ConfigService` 写盘，Zustand Store 做启动表面投影，SessionRuntime 持有执行快照 (`packages/cli/src/config/ConfigManager.ts`, `packages/cli/src/config/ConfigService.ts`, `packages/cli/src/store/vanilla.ts`)
- TypeBox schema 同时承担静态类型、HTTP 边界验证和公开字段投影，Web 通过 `@api` alias 直接消费同一源码合约 (`packages/cli/src/schema/index.ts`, `packages/cli/web/vite.config.ts`)

## Decisions
- 项目采用 source-project 级隔离而非进程 cwd 级隔离，因为同一 Serve/ACP 进程必须并发承载多个目录且不能共享可变 registry 或 endpoint (`docs/reference/workspace-agent-resources.md`, `docs/reference/workspace-model-resources.md`)
- 从 Zod 迁移到 TypeBox 是为同时保留原生 JSON Schema 与运行时解析能力，工具声明和 Server/Web 合约由同一 schema 体系生成 (`packages/cli/src/schema/index.ts`, `git:311ba368`)
- 资源限制同时约束 active 数量、pending 数量和 retained bytes；只限制并发数仍会让等待队列与输出缓冲无界增长 (`packages/cli/src/agent/runtime/TaskRunScheduler.ts`, `packages/cli/src/utils/BoundedSerialEgress.ts`, `git:1af43232`)

## Branching Behavior
- 不可信项目只能让 Hook 更严格，例如设置 `disableAllHooks=true`；模型、环境、权限放宽和项目扩展均不进入 Runtime (`packages/cli/src/config/ConfigManager.ts`)
- Session 快照创建后，配置、插件或规则变更只影响后续 Session；恢复路径通过 digest 和引用校验旧快照语义，不能静默采用新内容 (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- 有空闲执行槽时，Task 和 Provider 的 pending-byte 预算不参与拒绝；只有请求必须排队时才对 retained footprint 计费 (`packages/cli/src/agent/runtime/TaskRunScheduler.ts`, `packages/cli/src/services/pi/providerRequestAdmission.ts`)
- Web Session 驻留允许驱逐可回收的 idle Web Runtime，ACP 驻留不做隐式驱逐并要求宿主显式关闭 (`packages/cli/src/agent/runtime/SessionRuntimeResidency.ts`)
- SSE 初始化阶段先缓冲 live 事件；完成 replay 后只补发高于 replay 水位的 committed 事件，并丢弃该窗口内无法可靠排序的 ephemeral delta (`packages/cli/src/server/OrderedSseEgress.ts`)

## Child Knowledge Nodes
- `./layered-configuration-and-runtime-settings/SKILL.md` — 使用时机：调整配置层级、字段写入位置、workspace 运行时设置或 Web 配置同步
- `./permissions-and-workspace-trust/SKILL.md` — 使用时机：修改权限模式、allow/ask/deny、审批作用域、Folder/Hook Trust 或网络安全
- `./workspace-resource-snapshots-and-project-instructions/SKILL.md` — 使用时机：修改 Agent/模型资源隔离、Session 快照、通信风格或路径条件项目规则
- `./shared-api-and-runtime-schemas/SKILL.md` — 使用时机：新增跨 Server/Web 数据字段、TypeBox schema、默认值或公开投影
- `./capacity-lifecycle-and-egress/SKILL.md` — 使用时机：修改 Session/Task/Tool/Provider/Browser 容量、公平队列、输出背压或资源回收
- `./runtime-state-bootstrap-and-observability/SKILL.md` — 使用时机：修改 cwd/project root 启动状态、共享 Store、日志、运行版本、Session ID 或项目注册
