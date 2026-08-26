---
name: knowledge-blade-code
description: >
  Covers Blade Code 项目总览、主要运行时边界及知识树导航。
  Navigate when: 理解项目架构、定位 CLI/Web/ACP/VS Code 的共享实现、规划跨域改动、判断功能应落在哪个模块。
  Excludes: 各领域的实现细节，请继续进入对应子节点。
  Keywords: Blade Code, coding agent, SessionRuntime, Agent, CLI, Web, ACP, VS Code, architecture, codebase overview.
---

## Module Structure

Blade Code 是 TypeScript monorepo：`packages/cli` 同时承载无状态 Agent 核心、Session runtime、工具平台、Provider 与 CLI/Server/ACP 表面；`packages/cli/web` 是 React Web 投影；`packages/vscode` 提供编辑器桥接。权威会话状态来自持久事件与资源快照，而不是任一 UI Store。

### Directory Layout
- `packages/cli/src/agent/` — Agent 决策循环、Session runtime、子代理与团队编排
- `packages/cli/src/context/` — transcript、事件日志、上下文压缩与恢复
- `packages/cli/src/tools/` — 工具契约、注册表、执行管线与内置工具
- `packages/cli/src/services/` — Provider、Session 与共享服务实现
- `packages/cli/src/mcp/`、`packages/cli/src/plugins/`、`packages/cli/src/skills/`、`packages/cli/src/hooks/`、`packages/cli/src/lsp/` — 扩展生态
- `packages/cli/src/ui/`、`packages/cli/src/server/`、`packages/cli/src/acp/` — TUI、Web 服务与 ACP 宿主表面
- `packages/cli/web/` — React + Vite Web 客户端
- `packages/vscode/` — VS Code WebSocket 桥接扩展
- `packages/cli/tests/`、`packages/cli/scripts/`、`.github/workflows/` — 测试、资格认证和发布链路

### Key Entry Points
- `packages/cli/src/blade.tsx` — CLI/TUI、Headless、ACP、Web/Serve 的统一进程入口
- `packages/cli/src/agent/Agent.ts` — 无状态决策器和连续 Goal 推进入口
- `packages/cli/src/agent/runtime/SessionRuntime.ts` — Session 资源与生命周期聚合边界
- `packages/cli/src/context/events/SessionEventLog.ts` — committed event 的持久化与跨表面扇出入口
- `packages/cli/src/server/server.ts` — Hono 服务、调度器和关闭流程装配入口
- `packages/cli/web/src/main.tsx` — Web 客户端入口

## Gotchas
- 不要把 TUI/Web Zustand Store 当作权威状态；恢复、重连和跨表面一致性必须从 committed Session 事件或持久 metadata 投影 (`packages/cli/src/context/events/SessionEventLog.ts`, `packages/cli/src/store/`, `packages/cli/web/src/store/`)
- `Agent` 的无状态不等于 Session 无状态；模型选择、工具目录、MCP/LSP/Browser、durable inbox 和执行租约都由 `SessionRuntime` 持有，绕开它会破坏恢复与清理 (`packages/cli/src/agent/Agent.ts`, `packages/cli/src/agent/runtime/SessionRuntime.ts`)
- `ToolKind.ReadOnly` 是权限分类而非幂等或并发证明；并发、流式预启动和瞬态重放分别由独立 capability 控制 (`packages/cli/src/tools/types/ToolTypes.ts`, `packages/cli/src/tools/core/createTool.ts`)
- Web、ACP 与 Headless 不是三套 Agent runtime；表面层应适配同一 `SessionRuntime`/loop event 契约，不能在客户端重建业务状态机 (`packages/cli/src/server/routes/session.ts`, `packages/cli/src/acp/Session.ts`, `packages/cli/src/commands/headless.ts`)
- docs 根目录中文与 `docs/en` 英文是同一用户契约，而 changelog 页面由工作流生成；不要直接编辑生成的 docs changelog (`AGENTS.md`, `.github/workflows/docs.yml`)

## Architecture
- 主路径是输入先进入 durable inbox，再由 Session 获取 turn ownership，Agent loop 调用 Provider 与工具，结果提交后通过统一事件日志投影到各表面 (`packages/cli/src/agent/runtime/ActiveTurnMailbox.ts`, `packages/cli/src/agent/loop/executeLoopGenerator.ts`, `packages/cli/src/context/events/SessionEventLog.ts`)
- 工具副作用在 durable tool-use 成功提交后才启动，tool-result 也先提交再通知表面；进程崩溃恢复会关闭 dangling 调用并标记不确定副作用 (`packages/cli/src/agent/loop/conversationPersistence.ts`, `packages/cli/src/context/storage/PersistentStore.ts`)
- Provider runtime 在 pi-ai 适配层上叠加请求准入、流停滞检测、重试、熔断、fallback 和 Prompt Cache 观测，这些策略跨所有交互表面共享 (`packages/cli/src/services/PiAIChatService.ts`, `packages/cli/src/services/pi/`)
- 扩展资源按 workspace 发现后冻结为 Session 快照；插件变更影响新 Session，不能在运行中静默改写旧 Session 的工具和提示词 (`packages/cli/src/agent/resources/WorkspaceAgentResources.ts`, `packages/cli/src/plugins/PluginRegistry.ts`)
- 生产资格认证是发布契约的一部分，真实 Provider、raw PTY、Chromium Web 与 ACP 轨迹用于证明同一 runtime 在不同宿主上的行为一致 (`packages/cli/scripts/qualification.ts`, `packages/cli/tests/integration/real-api/`)

## Conventions
- Runtime schema 使用项目 TypeBox wrapper，工具和 API 不引入 Zod；Provider 能力来自模型目录而非硬编码模型名 (`packages/cli/src/schema/`, `packages/cli/src/services/pi/PiModelCatalog.ts`)
- 每个独立 feature/fix 使用单独 npm patch，版本同步 `packages/cli/package.json`、`bun.lock` 与双语根 changelog (`AGENTS.md`, `packages/cli/scripts/release.js`)
- 集成测试应走真实边界；测试临时目录、子进程、BrowserContext 和端口必须由 harness 明确拥有并在结束时回收 (`packages/cli/tests/support/`, `packages/cli/scripts/qualification.ts`)

## Child Knowledge Nodes

### Core Runtime
- `./agent-execution-and-orchestration/SKILL.md` — Navigate when: 修改 Agent loop、完成策略、子代理、Agent Teams、Goal 或任务调度
- `./session-state-and-context/SKILL.md` — Navigate when: 修改 Session 状态、事件持久化、恢复、压缩、Token 预算或活动轮次交互
- `./tool-and-automation-platform/SKILL.md` — Navigate when: 新增工具或修改执行管线、文件/Shell、Browser 和 worktree 自动化
- `./model-and-provider-runtime/SKILL.md` — Navigate when: 修改模型目录、Provider 协议、请求恢复、准入、熔断或缓存观测

### Interaction And Extensions
- `./extension-ecosystem/SKILL.md` — Navigate when: 修改 MCP、插件、Skills、自定义命令、Hooks 或 LSP
- `./interaction-surfaces/SKILL.md` — Navigate when: 修改 CLI/TUI、Headless、Hono/Web、ACP 或 VS Code 表面

### Shared Components
- `./session-state-and-context/durable-transcript-and-event-projection/SKILL.md` — Navigate when: 复用或改变 committed event、JSONL/SQLite 投影及 replay/live 交接
- `./tool-and-automation-platform/tool-contracts-and-registry/SKILL.md` — Navigate when: 定义 Tool、schema、注册表或 deferred/MCP 目录契约
- `./tool-and-automation-platform/tool-execution-pipeline/SKILL.md` — Navigate when: 改变权限、并发、Hook、重试、取消或验证阶段顺序
- `./workspace-policy-and-shared-foundations/SKILL.md` — Navigate when: 修改配置、安全、共享 schema、workspace 快照、容量或生命周期基础设施

### Cross-Cutting Patterns
- `./model-and-provider-runtime/provider-resilience-admission-and-observability/SKILL.md` — Navigate when: 调试 Provider 排队、重试、熔断、stall、Prompt Cache 或费用
- `./extension-ecosystem/hooks-and-behavior-interception/SKILL.md` — Navigate when: 修改跨 Session/Tool/Subagent/MCP 的 Hook 分支
- `./workspace-policy-and-shared-foundations/permissions-and-workspace-trust/SKILL.md` — Navigate when: 修改 permission mode、审批、敏感文件或 workspace trust
- `./workspace-policy-and-shared-foundations/capacity-lifecycle-and-egress/SKILL.md` — Navigate when: 修改 Session/Task/Tool/Provider/Browser 容量、背压、取消或清理
- `./engineering-quality-and-delivery/SKILL.md` — Navigate when: 修改测试分层、真实 API 资格、性能/安全门禁、构建、发布或双语文档

## Generation Metadata

- Generation timestamp: `2026-08-26T17:29:52Z`
- Scale and depth: `M`; actual depth `3`; required/recommended depth `3`
- Totals: `49` knowledge nodes; `1185` knowledge entries; `521` unique source references; `110` unique Git commit references
- Coverage: `8/8` designed domains covered; `30/30` Git-visible first-level runtime source directories under `packages/cli/src/` covered; `6/6` ancillary roots (`packages/cli/web/src/`, `packages/vscode/src/`, `packages/cli/tests/`, `packages/cli/scripts/`, `.github/workflows/`, `docs/`) covered
- Category totals: Gotchas `497`; Architecture `222`; Decisions `150`; Patterns `123`; Conventions `12`; Dependencies `16`; Consumer Analysis `50`; Branching Behavior `54`; Security Considerations `16`; Error Handling & Recovery `7`; Scheduling Boundaries `3`; Recovery Semantics `3`; Storage And Integrity `4`; Observability and Privacy `3`; Provider Response Semantics `3`; Concurrency Model `3`; Context Preservation `3`; Performance Characteristics `3`; Compatibility `3`; Resource And Failure Bounds `4`; Recovery And Consistency `3`; Resource Bounds `3`

| Node | Entries | Categories |
|------|---------|------------|
| `.` | 13 | Gotchas 5; Architecture 5; Conventions 3 |
| `agent-execution-and-orchestration` | 13 | Gotchas 4; Architecture 5; Decisions 2; Patterns 2 |
| `agent-execution-and-orchestration/agent-teams` | 22 | Gotchas 11; Architecture 5; Decisions 3; Patterns 3 |
| `agent-execution-and-orchestration/decision-loop-and-completion` | 28 | Gotchas 12; Architecture 5; Decisions 4; Patterns 3; Error Handling & Recovery 4 |
| `agent-execution-and-orchestration/goals-tasks-and-scheduling` | 30 | Gotchas 14; Architecture 6; Decisions 4; Patterns 3; Scheduling Boundaries 3 |
| `agent-execution-and-orchestration/subagent-runtime` | 25 | Gotchas 10; Architecture 5; Decisions 4; Patterns 3; Recovery Semantics 3 |
| `engineering-quality-and-delivery` | 16 | Gotchas 4; Architecture 3; Decisions 2; Patterns 2; Conventions 1; Branching Behavior 4 |
| `engineering-quality-and-delivery/build-release-and-documentation` | 25 | Gotchas 9; Architecture 4; Decisions 3; Patterns 3; Dependencies 1; Branching Behavior 5 |
| `engineering-quality-and-delivery/performance-security-and-snapshot-gates` | 21 | Gotchas 7; Architecture 3; Decisions 2; Patterns 3; Security Considerations 2; Branching Behavior 4 |
| `engineering-quality-and-delivery/real-api-qualification-and-e2e` | 22 | Gotchas 8; Architecture 4; Decisions 2; Patterns 3; Branching Behavior 5 |
| `engineering-quality-and-delivery/unit-integration-and-shared-test-harnesses` | 20 | Gotchas 6; Architecture 3; Decisions 2; Patterns 3; Dependencies 1; Branching Behavior 5 |
| `extension-ecosystem` | 15 | Gotchas 5; Architecture 5; Decisions 3; Patterns 2 |
| `extension-ecosystem/hooks-and-behavior-interception` | 30 | Gotchas 15; Architecture 4; Decisions 3; Patterns 2; Branching Behavior 6 |
| `extension-ecosystem/lsp-code-intelligence` | 26 | Gotchas 12; Architecture 4; Decisions 3; Patterns 2; Consumer Analysis 5 |
| `extension-ecosystem/mcp-protocol-runtime` | 38 | Gotchas 11; Architecture 8; Decisions 5; Patterns 3; Dependencies 2; Security Considerations 6; Error Handling & Recovery 3 |
| `extension-ecosystem/plugin-lifecycle-and-marketplace` | 34 | Gotchas 12; Architecture 5; Decisions 4; Patterns 4; Conventions 3; Dependencies 2; Storage And Integrity 4 |
| `extension-ecosystem/skills-and-custom-commands` | 26 | Gotchas 12; Architecture 4; Decisions 3; Patterns 2; Consumer Analysis 5 |
| `interaction-surfaces` | 16 | Gotchas 6; Architecture 4; Decisions 3; Patterns 3 |
| `interaction-surfaces/acp-host-integration` | 29 | Gotchas 13; Architecture 6; Decisions 4; Patterns 5; Dependencies 1 |
| `interaction-surfaces/cli-bootstrap-headless-and-print` | 24 | Gotchas 11; Architecture 5; Decisions 3; Patterns 4; Dependencies 1 |
| `interaction-surfaces/hono-server-api-and-streaming` | 28 | Gotchas 12; Architecture 6; Decisions 4; Patterns 5; Dependencies 1 |
| `interaction-surfaces/terminal-ui` | 26 | Gotchas 11; Architecture 6; Decisions 3; Patterns 5; Dependencies 1 |
| `interaction-surfaces/vscode-bridge` | 18 | Gotchas 8; Architecture 4; Decisions 2; Patterns 3; Dependencies 1 |
| `interaction-surfaces/web-client` | 32 | Gotchas 15; Architecture 7; Decisions 4; Patterns 5; Dependencies 1 |
| `model-and-provider-runtime` | 11 | Gotchas 3; Architecture 3; Decisions 2; Patterns 2; Dependencies 1 |
| `model-and-provider-runtime/model-catalog-configuration-and-credentials` | 19 | Gotchas 7; Architecture 4; Decisions 3; Patterns 3; Security Considerations 2 |
| `model-and-provider-runtime/provider-resilience-admission-and-observability` | 37 | Gotchas 9; Architecture 6; Decisions 4; Patterns 4; Conventions 2; Dependencies 1; Branching Behavior 8; Observability and Privacy 3 |
| `model-and-provider-runtime/provider-transport-and-context-adaptation` | 20 | Gotchas 8; Architecture 4; Decisions 2; Patterns 3; Provider Response Semantics 3 |
| `session-state-and-context` | 15 | Gotchas 5; Architecture 4; Decisions 3; Conventions 3 |
| `session-state-and-context/active-turn-interactions-and-recovery` | 33 | Gotchas 18; Architecture 5; Decisions 4; Concurrency Model 3; Security Considerations 3 |
| `session-state-and-context/context-compaction-token-budget-and-memory` | 18 | Gotchas 8; Architecture 5; Decisions 3; Patterns 2 |
| `session-state-and-context/context-compaction-token-budget-and-memory/compaction-pipeline-and-checkpoints` | 27 | Gotchas 16; Architecture 4; Decisions 4; Context Preservation 3 |
| `session-state-and-context/context-compaction-token-budget-and-memory/project-auto-memory` | 19 | Gotchas 10; Architecture 4; Decisions 2; Patterns 3 |
| `session-state-and-context/durable-transcript-and-event-projection` | 26 | Gotchas 10; Architecture 5; Decisions 3; Performance Characteristics 3; Consumer Analysis 5 |
| `session-state-and-context/session-catalog-fork-rewind-and-export` | 31 | Gotchas 16; Architecture 5; Decisions 4; Security Considerations 3; Compatibility 3 |
| `tool-and-automation-platform` | 15 | Gotchas 5; Architecture 4; Decisions 3; Patterns 3 |
| `tool-and-automation-platform/browser-automation` | 30 | Gotchas 12; Architecture 6; Decisions 4; Patterns 4; Resource And Failure Bounds 4 |
| `tool-and-automation-platform/filesystem-search-and-atomic-patching` | 28 | Gotchas 12; Architecture 5; Decisions 3; Patterns 5; Recovery And Consistency 3 |
| `tool-and-automation-platform/integration-and-workflow-tool-adapters` | 26 | Gotchas 11; Architecture 4; Decisions 3; Patterns 3; Consumer Analysis 5 |
| `tool-and-automation-platform/shell-process-and-worktree` | 27 | Gotchas 12; Architecture 5; Decisions 3; Patterns 4; Resource Bounds 3 |
| `tool-and-automation-platform/tool-contracts-and-registry` | 24 | Gotchas 9; Architecture 4; Decisions 3; Patterns 3; Consumer Analysis 5 |
| `tool-and-automation-platform/tool-execution-pipeline` | 28 | Gotchas 11; Architecture 5; Decisions 3; Patterns 4; Consumer Analysis 5 |
| `workspace-policy-and-shared-foundations` | 17 | Gotchas 6; Architecture 3; Decisions 3; Branching Behavior 5 |
| `workspace-policy-and-shared-foundations/capacity-lifecycle-and-egress` | 29 | Gotchas 16; Architecture 3; Decisions 3; Branching Behavior 7 |
| `workspace-policy-and-shared-foundations/layered-configuration-and-runtime-settings` | 24 | Gotchas 10; Architecture 3; Decisions 3; Patterns 3; Consumer Analysis 5 |
| `workspace-policy-and-shared-foundations/permissions-and-workspace-trust` | 23 | Gotchas 12; Architecture 3; Decisions 3; Branching Behavior 5 |
| `workspace-policy-and-shared-foundations/runtime-state-bootstrap-and-observability` | 34 | Gotchas 13; Architecture 6; Decisions 4; Patterns 4; Dependencies 2; Consumer Analysis 5 |
| `workspace-policy-and-shared-foundations/shared-api-and-runtime-schemas` | 23 | Gotchas 12; Architecture 3; Decisions 3; Consumer Analysis 5 |
| `workspace-policy-and-shared-foundations/workspace-resource-snapshots-and-project-instructions` | 24 | Gotchas 13; Architecture 3; Decisions 3; Consumer Analysis 5 |
